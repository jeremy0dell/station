import type { StationConfig } from "@station/config";
import {
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  ObserverRestartCommandResultSchema,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  type SafeError,
  type UpdateArtifact,
  type UpdateReapRecoveryPreflight,
} from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  type StationBuildInfo,
} from "@station/runtime";
import type { CliRunResult } from "../cliTypes.js";
import type { CliEnv } from "../env.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  type PlannedUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "../update/channelDetection.js";
import { createDefaultUpdateProbes } from "../update/defaultUpdateProbes.js";
import type { UpdateApplyReportBase, UpdateCommandArgv } from "../update/updateChannel.js";
import { updateErrorFromUnknown } from "../update/updateError.js";
import type { HostCommandDeps } from "./host/index.js";
import { parseUpdateRequest, type UpdateRequest } from "./update/args.js";
import {
  createUpdateReport,
  currentUpdateResult,
  deferredUpdateResult,
  failedUpdateResult,
  previewCurrentUpdateResult,
  previewUpdateResult,
  type UpdateCommandReport,
  updatedUpdateResult,
  updateStep,
} from "./update/report.js";
import {
  type HostHandoffScenario,
  resolveUpdateScenario,
  type UpdateScenario,
} from "./update/scenario.js";

export type UpdateCommandOptions = {
  config: StationConfig;
  configPath?: string;
  cliEntryPath: string;
  env?: CliEnv;
};

export type UpdateCommandDeps = {
  probes?: readonly UpdateChannelProbe[];
  buildInfo?: () => StationBuildInfo;
  executablePath?: string;
  commandRunner?: ExternalCommandRunner;
  hostDeps?: HostCommandDeps;
  /** Runs the composed read-only assessment required only by `--dry-run --reap`. */
  recoveryPreflight?: (input: {
    installed: UpdateArtifact;
    target: UpdateArtifact;
  }) => Promise<UpdateReapRecoveryPreflight>;
};

type ExecutableUpdateScenario = Extract<
  UpdateScenario,
  { kind: "defer-to-package-manager" | "apply-update" }
>;

const OBSERVER_CROSSOVER_TIMEOUT_MS = 20_000;

/**
 * ADAPTER
 *
 * Selects one owned install channel and optionally aggregates non-authorizing recovery facts.
 * Apply mode then preflights Host preservation, reconciles hooks through the selected launcher,
 * and crosses runtimes; recovery preflight itself exposes no mutation capability.
 */
export async function runUpdateCommand(
  args: readonly string[],
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<CliRunResult> {
  const request = parseUpdateRequest(args);
  const selected = await selectUpdateChannel({
    probes: deps.probes ?? createDefaultUpdateProbes(options, deps),
    ...(request.channel === undefined ? {} : { requested: request.channel }),
  });
  const report = createUpdateReport(selected);
  if (request.reap) {
    if (deps.recoveryPreflight === undefined) {
      throw {
        tag: "UpdatePreflightError",
        code: "UPDATE_PREFLIGHT_PORTS_UNAVAILABLE",
        message: "Update recovery preflight is unavailable in this CLI composition.",
      } satisfies SafeError;
    }
    report.recoveryPreflight = await deps.recoveryPreflight({
      installed: report.current,
      target: report.target,
    });
  }
  const scenario = await resolveUpdateScenario({
    selected,
    request,
    config: options.config,
    ...(deps.hostDeps === undefined ? {} : { hostDeps: deps.hostDeps }),
  });

  switch (scenario.kind) {
    case "already-current":
      if (request.mode === "preview") {
        return previewCurrentUpdateResult(report, request.output);
      }
      return reconcileCurrentInstallation(selected, report, request, options, deps.commandRunner);
    case "preview":
      return previewUpdateResult(report, scenario, request.output);
    case "defer-to-package-manager":
    case "apply-update":
      return executeSelectedUpdate(selected, scenario, report, request, options, deps);
  }
}

async function executeSelectedUpdate(
  selected: PlannedUpdateChannel,
  scenario: ExecutableUpdateScenario,
  report: UpdateCommandReport,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
  let applied: UpdateApplyReportBase;
  try {
    applied = await selected.apply({ drivePackageManager: scenario.drivePackageManager });
  } catch (error) {
    const recoveryCommands = selected.applyRecoveryCommands?.(error) ?? [
      retryUpdateCommand(selected.plan.currentCli, options.configPath, request),
    ];
    return failedUpdateResult(report, "apply", error, recoveryCommands, request.output);
  }

  report.warnings.push(...applied.warnings);
  if (applied.status === "deferred") {
    return deferredUpdateResult(report, selected.plan.managerCommand, request.output);
  }
  report.steps.push(
    updateStep("apply", "completed", `Installed Station ${applied.installedVersion}.`),
  );
  if (scenario.hostHandoff.kind === "not-requested") {
    report.warnings.push({
      tag: "UpdateWarning",
      code: "UPDATE_HOST_HANDOFF_DISABLED",
      message: "Host handoff was disabled; the next TUI may refuse the incumbent Host.",
    });
  }

  if (applied.successorCli === undefined) {
    return failedUpdateResult(
      report,
      "observer-restart",
      updateErrorFromUnknown(undefined, {
        code: "UPDATE_CROSSOVER_INVALID",
        message: "The update committed without identifying its successor Station launcher.",
      }),
      [retryUpdateCommand(selected.plan.currentCli, options.configPath, request)],
      request.output,
    );
  }

  return crossOverRuntime(
    applied.successorCli,
    scenario.hostHandoff,
    report,
    request,
    options,
    deps.commandRunner,
  );
}

async function crossOverRuntime(
  successorCli: ExecutableArgv,
  hostHandoff: HostHandoffScenario,
  report: UpdateCommandReport,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  commandRunner: ExternalCommandRunner | undefined,
): Promise<CliRunResult> {
  const hookCommand = stationCommand(successorCli, options.configPath, [
    "hooks",
    "reconcile",
    "codex",
  ]);
  const hookFailure = await reconcileUpdateHooks(report, hookCommand, commandRunner);
  if (hookFailure !== undefined) {
    return failedUpdateResult(report, "hook-reconciliation", hookFailure, [], request.output);
  }

  // Crossover must use the successor launcher: hooks first, then Observer and Host.
  const observerCommand = stationCommand(successorCli, options.configPath, [
    "observer",
    "restart",
    "--timeout-ms",
    String(OBSERVER_CROSSOVER_TIMEOUT_MS),
  ]);
  try {
    const lifecycleFailure = await runObserverCrossover(observerCommand, commandRunner);
    if (lifecycleFailure !== undefined) {
      return failedUpdateResult(
        report,
        "observer-restart",
        updateErrorFromUnknown(undefined, {
          code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
          message: "Station installed the new build but runtime crossover did not complete.",
        }),
        [observerCommand],
        request.output,
        lifecycleFailure,
      );
    }
    report.steps.push(
      updateStep(
        "observer-restart",
        "completed",
        "The Observer is running from the installed build.",
      ),
    );
  } catch (error) {
    return failedUpdateResult(report, "observer-restart", error, [observerCommand], request.output);
  }

  if (hostHandoff.kind === "handoff") {
    const hostCommand = stationCommand(successorCli, options.configPath, [
      "host",
      "handoff",
      "--fidelity",
      hostHandoff.fidelity,
    ]);
    try {
      await runCrossover(hostCommand, commandRunner);
    } catch (error) {
      return failedUpdateResult(report, "host-handoff", error, [hostCommand], request.output);
    }
  }

  return updatedUpdateResult(report, hostHandoff, request.output);
}

async function reconcileCurrentInstallation(
  selected: PlannedUpdateChannel,
  report: UpdateCommandReport,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  commandRunner: ExternalCommandRunner | undefined,
): Promise<CliRunResult> {
  report.steps.push(
    updateStep("apply", "skipped", "The selected installation already matches its target."),
  );
  const command = stationCommand(selected.plan.currentCli, options.configPath, [
    "hooks",
    "reconcile",
    "codex",
  ]);
  const failure = await reconcileUpdateHooks(report, command, commandRunner);
  if (failure !== undefined) {
    return failedUpdateResult(report, "hook-reconciliation", failure, [], request.output);
  }
  return currentUpdateResult(report, request.output);
}

async function reconcileUpdateHooks(
  report: UpdateCommandReport,
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<SafeError | undefined> {
  try {
    const result = await runHookReconciliation(command, runner);
    report.hookReconciliation = result;
    switch (result.status) {
      case "configured-disabled":
        report.steps.push(
          updateStep(
            "hook-reconciliation",
            "completed",
            "Configured provider hook installation is disabled.",
          ),
        );
        return undefined;
      case "unsupported":
        report.steps.push(
          updateStep(
            "hook-reconciliation",
            "completed",
            "The selected provider does not support managed hooks.",
          ),
        );
        return undefined;
      case "healthy":
        report.steps.push(
          updateStep("hook-reconciliation", "completed", "Configured provider hooks are healthy."),
        );
        return undefined;
      case "repaired":
        report.steps.push(
          updateStep(
            "hook-reconciliation",
            "completed",
            "Configured provider hooks were repaired and verified.",
          ),
        );
        return undefined;
      case "ownership-conflict":
        return updateErrorFromUnknown(undefined, {
          code: "UPDATE_HOOK_OWNERSHIP_CONFLICT",
          message: "Configured provider hooks are owned by another installation.",
          hint: "Use the explicit Codex hook takeover flow before retrying the update.",
        });
      case "write-failed":
      case "post-write-doctor-failed":
      case "inspection-failed":
        return result.error;
    }
  } catch (error) {
    return updateErrorFromUnknown(error, {
      code: "UPDATE_HOOK_RECONCILIATION_FAILED",
      message: "Station could not verify configured provider hooks.",
      hint: "Run provider hook doctor and retry the update after correcting the reported issue.",
    });
  }
}

async function runHookReconciliation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ProviderHookReconciliationResult> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 64 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = ProviderHookReconciliationResultSchema.parse(JSON.parse(result.stdout));
  const succeeded =
    parsed.status === "configured-disabled" ||
    parsed.status === "unsupported" ||
    parsed.status === "healthy" ||
    parsed.status === "repaired";
  if ((result.exitCode === 0) !== succeeded) {
    throw new Error("Hook reconciliation result contradicted its process exit status.");
  }
  return parsed;
}

async function runCrossover(command: UpdateCommandArgv, runner: ExternalCommandRunner | undefined) {
  const [executable, ...args] = command;
  try {
    await runExternalCommand(
      {
        command: executable,
        args,
        timeoutMs: 60_000,
        maxOutputChars: 64 * 1024,
      },
      runner,
    );
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: "Station installed the new build but runtime crossover did not complete.",
    });
  }
}

async function runObserverCrossover(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ObserverLifecycleFailure | undefined> {
  const [executable, ...args] = command;
  try {
    const result = await runExternalCommand(
      {
        command: executable,
        args,
        timeoutMs: 60_000,
        maxOutputChars: 64 * 1024,
        allowedExitCodes: [1],
      },
      runner,
    );
    const parsed = ObserverRestartCommandResultSchema.parse(JSON.parse(result.stdout));
    if (result.exitCode === 0 && parsed.status === "running") return undefined;
    if (result.exitCode !== 0 && parsed.status !== "running") {
      const failure: ObserverLifecycleFailure = { error: parsed.error };
      if (parsed.cause !== undefined) failure.cause = parsed.cause;
      if (parsed.startupEvidence !== undefined) {
        failure.startupEvidence = parsed.startupEvidence;
      }
      return ObserverLifecycleFailureSchema.parse(failure);
    }
    throw new Error("Observer restart result contradicted its process exit status.");
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: "Station installed the new build but runtime crossover did not complete.",
    });
  }
}

function stationCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  operation: string[],
): UpdateCommandArgv {
  const [command, ...prefix] = cli;
  return [
    command,
    ...prefix,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    ...operation,
  ];
}

function retryUpdateCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  request: UpdateRequest,
): UpdateCommandArgv {
  return stationCommand(cli, configPath, [
    "update",
    ...(request.channel === undefined ? [] : ["--channel", request.channel]),
    ...(request.packageManager === "drive" ? ["--drive-package-manager"] : []),
    ...(request.handoff === undefined ? ["--no-handoff"] : [`--handoff=${request.handoff}`]),
  ]);
}
