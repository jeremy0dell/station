import type { StationConfig } from "@station/config";
import {
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  ObserverRestartCommandResultSchema,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  projectPublicUpdateReport,
  providerHookReconciliationSucceeded,
  type SafeError,
  type StationHostConvergenceFailureSummary,
  StationHostUpdateCrossoverResultSchema,
  type UpdateArtifact,
  UpdateConvergencePlanningInputSchema,
  type UpdateReapRecoveryPreflight,
} from "@station/contracts";
import {
  type ExternalCommandRunner,
  runExternalCommand,
  type StationBuildInfo,
  stationBuildInfo,
  stationObserverBuildVersion,
} from "@station/runtime";
import type { CliRunResult } from "../cliTypes.js";
import type { CliEnv } from "../env.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  type PlannedUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "../update/channelDetection.js";
import { deriveUpdateConvergencePlan } from "../update/convergencePlan.js";
import type { UpdateApplyReportBase, UpdateCommandArgv } from "../update/updateChannel.js";
import { updateErrorFromUnknown } from "../update/updateError.js";
import { resolveUpdateInstallationIntent } from "../update/updateInstallationIntent.js";
import type { HostCommandDeps } from "./host/index.js";
import { parseUpdateRequest, type UpdateRequest } from "./update/args.js";
import {
  createUpdateReport,
  currentUpdateResult,
  deferredUpdateResult,
  failedUpdateResult,
  previewUpdateCommandResult,
  type UpdateCommandResultDraft,
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
  currentBuildInfo?: StationBuildInfo;
  executablePath?: string;
  commandRunner?: ExternalCommandRunner;
  hostDeps?: HostCommandDeps;
  /** Runs the composed read-only assessment required by every update dry run. */
  recoveryPreflight?: (input: {
    installed: UpdateArtifact;
    target: UpdateArtifact;
    currentBuildInfo: StationBuildInfo;
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
 * Selects one owned install channel from one captured build identity. Preview validates manager
 * intent, aggregates read-only runtime facts, and returns one canonical plan before mutation.
 * Apply mode retains Host preservation, hook reconciliation, and runtime crossover behavior.
 */
export async function runUpdateCommand(
  args: readonly string[],
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<CliRunResult> {
  const request = parseUpdateRequest(args);
  const currentBuildInfo = deps.currentBuildInfo ?? (deps.buildInfo ?? stationBuildInfo)();
  if (deps.probes === undefined) {
    throw new Error("Update channel probes are unavailable in this CLI composition.");
  }
  const selected = await selectUpdateChannel({
    probes: deps.probes,
    ...(request.channel === undefined ? {} : { requested: request.channel }),
  });
  const installation = resolveUpdateInstallationIntent(selected, request.packageManager);
  if (request.mode === "preview") {
    if (deps.recoveryPreflight === undefined) {
      throw {
        tag: "UpdatePreflightError",
        code: "UPDATE_PREFLIGHT_PORTS_UNAVAILABLE",
        message: "Update recovery preflight is unavailable in this CLI composition.",
      } satisfies SafeError;
    }
    const current = artifact(selected.plan.currentVersion, selected.plan.currentRevision);
    const target = artifact(selected.plan.targetVersion, selected.plan.targetRevision);
    const initial = await deps.recoveryPreflight({
      installed: current,
      target,
      currentBuildInfo,
    });
    const planningInput = UpdateConvergencePlanningInputSchema.parse({
      preflight: initial,
      targetRuntime: artifactsMatch(current, target)
        ? {
            status: "known",
            buildIdentity: currentBuildInfo.buildIdentity,
            observerSelector: stationObserverBuildVersion(currentBuildInfo),
          }
        : { status: "not-yet-provable" },
      installation,
      handoff:
        request.handoff === undefined
          ? { action: "leave-in-place" }
          : { action: "preserve", fidelity: request.handoff },
    });
    const plan = deriveUpdateConvergencePlan(planningInput);
    const report = projectPublicUpdateReport({
      schemaVersion: 4,
      kind: "preview",
      channel: selected.channel,
      current,
      target,
      initial,
      plan,
    });
    return previewUpdateCommandResult(report, request.output);
  }
  const report = createUpdateReport(selected);
  const scenario = await resolveUpdateScenario({
    selected,
    request,
    installation,
    currentBuildInfo,
    config: options.config,
    ...(deps.hostDeps === undefined ? {} : { hostDeps: deps.hostDeps }),
  });

  switch (scenario.kind) {
    case "already-current":
      return reconcileCurrentInstallation(
        selected,
        scenario.hostHandoff,
        report,
        request,
        options,
        deps.commandRunner,
      );
    case "defer-to-package-manager":
    case "apply-update":
      return executeSelectedUpdate(selected, scenario, report, request, options, deps);
  }
}

async function executeSelectedUpdate(
  selected: PlannedUpdateChannel,
  scenario: ExecutableUpdateScenario,
  report: UpdateCommandResultDraft,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps,
): Promise<CliRunResult> {
  let applied: UpdateApplyReportBase;
  try {
    applied = await selected.apply({
      drivePackageManager: scenario.drivePackageManager,
    });
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
    {
      launcher: applied.successorCli,
      hostHandoff: scenario.hostHandoff,
      observerAction: "restart",
      completionStatus: "updated",
    },
    report,
    request,
    options,
    deps.commandRunner,
  );
}

type RuntimeCrossoverPlan = {
  launcher: ExecutableArgv;
  hostHandoff: HostHandoffScenario;
  observerAction: "start" | "restart";
  completionStatus: "current" | "updated";
};

async function crossOverRuntime(
  plan: RuntimeCrossoverPlan,
  report: UpdateCommandResultDraft,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  commandRunner: ExternalCommandRunner | undefined,
): Promise<CliRunResult> {
  const hookCommand = stationCommand(plan.launcher, options.configPath, [
    "hooks",
    "reconcile",
    "codex",
  ]);
  const observerCommand = stationCommand(plan.launcher, options.configPath, [
    "observer",
    plan.observerAction,
    "--timeout-ms",
    String(OBSERVER_CROSSOVER_TIMEOUT_MS),
  ]);
  const hostCommand =
    plan.hostHandoff.kind === "converge"
      ? stationCommand(plan.launcher, options.configPath, [
          "host",
          "handoff",
          "--update-crossover",
          "--fidelity",
          plan.hostHandoff.fidelity,
        ])
      : undefined;
  const runtimeRecoveryCommands = [
    observerCommand,
    ...(hostCommand === undefined ? [] : [hostCommand]),
  ];
  const hookFailure = await reconcileUpdateHooks(report, hookCommand, commandRunner);
  if (hookFailure !== undefined) {
    return failedUpdateResult(
      report,
      "hook-reconciliation",
      hookFailure,
      hookReconciliationRecoveryCommands(
        plan.launcher,
        options.configPath,
        report.hookReconciliation,
        hookCommand,
        runtimeRecoveryCommands,
      ),
      request.output,
    );
  }

  // Every command remains pinned to the selected launcher: hooks first, then Observer and Host.
  try {
    const lifecycleFailure = await runObserverCrossover(
      observerCommand,
      plan.completionStatus,
      commandRunner,
    );
    if (lifecycleFailure !== undefined) {
      return failedUpdateResult(
        report,
        "observer-restart",
        updateErrorFromUnknown(undefined, {
          code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
          message: runtimeCrossoverFailureMessage(plan.completionStatus),
        }),
        runtimeRecoveryCommands,
        request.output,
        lifecycleFailure,
      );
    }
    report.steps.push(
      updateStep(
        "observer-restart",
        "completed",
        plan.completionStatus === "updated"
          ? "The Observer is running from the selected build."
          : "The accepted Observer singleton is running.",
      ),
    );
  } catch (error) {
    return failedUpdateResult(
      report,
      "observer-restart",
      error,
      runtimeRecoveryCommands,
      request.output,
    );
  }

  if (hostCommand !== undefined) {
    try {
      const failure = await runHostCrossover(hostCommand, plan.completionStatus, commandRunner);
      if (failure !== undefined) {
        return failedUpdateResult(
          report,
          "host-handoff",
          updateErrorFromUnknown(undefined, {
            code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
            message: runtimeCrossoverFailureMessage(plan.completionStatus),
          }),
          [hostCommand],
          request.output,
          undefined,
          failure.convergenceFailure,
          failure.error,
        );
      }
    } catch (error) {
      return failedUpdateResult(report, "host-handoff", error, [hostCommand], request.output);
    }
  }

  return plan.completionStatus === "updated"
    ? updatedUpdateResult(report, plan.hostHandoff, request.output)
    : currentUpdateResult(report, plan.hostHandoff, request.output);
}

async function reconcileCurrentInstallation(
  selected: PlannedUpdateChannel,
  hostHandoff: HostHandoffScenario,
  report: UpdateCommandResultDraft,
  request: UpdateRequest,
  options: UpdateCommandOptions,
  commandRunner: ExternalCommandRunner | undefined,
): Promise<CliRunResult> {
  report.steps.push(
    updateStep("apply", "skipped", "The selected installation already matches its target."),
  );
  if (hostHandoff.kind === "not-requested") {
    report.warnings.push({
      tag: "UpdateWarning",
      code: "UPDATE_HOST_HANDOFF_DISABLED",
      message: "Host handoff was disabled; the next TUI may refuse the incumbent Host.",
    });
  }
  return crossOverRuntime(
    {
      launcher: selected.plan.currentCli,
      hostHandoff,
      observerAction: "start",
      completionStatus: "current",
    },
    report,
    request,
    options,
    commandRunner,
  );
}

async function reconcileUpdateHooks(
  report: UpdateCommandResultDraft,
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
  const succeeded = providerHookReconciliationSucceeded(parsed);
  if ((result.exitCode === 0) !== succeeded) {
    throw new Error("Hook reconciliation result contradicted its process exit status.");
  }
  return parsed;
}

function hookReconciliationRecoveryCommands(
  launcher: ExecutableArgv,
  configPath: string | undefined,
  result: ProviderHookReconciliationResult | undefined,
  reconcileCommand: UpdateCommandArgv,
  runtimeCommands: readonly UpdateCommandArgv[],
): UpdateCommandArgv[] {
  const provider = result?.provider ?? "codex";
  const action = result !== undefined && "followUp" in result ? result.followUp.action : undefined;
  let prerequisiteCommands: UpdateCommandArgv[] = [];
  switch (action) {
    case "run-explicit-takeover":
      prerequisiteCommands = [
        stationCommand(launcher, configPath, ["hooks", "install", provider, "--yes", "--takeover"]),
      ];
      break;
    case "run-doctor":
    case "enable-hooks":
    case undefined:
      prerequisiteCommands = [stationCommand(launcher, configPath, ["hooks", "doctor", provider])];
      break;
    case "retry":
      break;
  }
  return [...prerequisiteCommands, reconcileCommand, ...runtimeCommands];
}

async function runHostCrossover(
  command: UpdateCommandArgv,
  completionStatus: RuntimeCrossoverPlan["completionStatus"],
  runner: ExternalCommandRunner | undefined,
): Promise<
  | {
      error: SafeError;
      convergenceFailure?: StationHostConvergenceFailureSummary;
    }
  | undefined
> {
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
    const parsed = StationHostUpdateCrossoverResultSchema.parse(JSON.parse(result.stdout));
    if (result.exitCode === 0 && parsed.status === "completed") return undefined;
    if (result.exitCode === 1 && parsed.status === "failed") {
      return {
        error: parsed.error,
        ...(parsed.convergenceFailure === undefined
          ? {}
          : { convergenceFailure: parsed.convergenceFailure }),
      };
    }
    throw new Error("Host crossover result contradicted its process exit status.");
  } catch (error) {
    throw updateErrorFromUnknown(error, {
      code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
      message: runtimeCrossoverFailureMessage(completionStatus),
    });
  }
}

async function runObserverCrossover(
  command: UpdateCommandArgv,
  completionStatus: RuntimeCrossoverPlan["completionStatus"],
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
      message: runtimeCrossoverFailureMessage(completionStatus),
    });
  }
}

function runtimeCrossoverFailureMessage(
  completionStatus: RuntimeCrossoverPlan["completionStatus"],
): string {
  return completionStatus === "updated"
    ? "Station installed the new build but runtime crossover did not complete."
    : "Station could not complete runtime convergence for the current build.";
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

function artifact(version: string, revision: string | undefined): UpdateArtifact {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

function artifactsMatch(left: UpdateArtifact, right: UpdateArtifact): boolean {
  return left.version === right.version && left.revision === right.revision;
}
