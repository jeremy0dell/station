import type { StationConfig } from "@station/config";
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

export type { UpdateCommandReport, UpdateCommandStep } from "./update/report.js";
export { renderUpdateReport } from "./update/report.js";

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
};

type ExecutableUpdateScenario = Extract<
  UpdateScenario,
  { kind: "defer-to-package-manager" | "apply-update" }
>;

/**
 * ADAPTER
 *
 * Selects one owned install channel, preflights default live Host preservation, and crosses runtimes through the successor launcher after mutation.
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
  const scenario = await resolveUpdateScenario({
    selected,
    request,
    config: options.config,
    ...(deps.hostDeps === undefined ? {} : { hostDeps: deps.hostDeps }),
  });

  switch (scenario.kind) {
    case "already-current":
      return currentUpdateResult(report, request.output);
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
  // Crossover must use the successor launcher: Observer first, then any planned Host handoff.
  const observerCommand = stationCommand(successorCli, options.configPath, ["observer", "restart"]);
  try {
    await runCrossover(observerCommand, commandRunner);
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
