import type { StationConfig } from "@station/config";
import type { HostHandoffFidelity, SafeError } from "@station/contracts";
import {
  type ExternalCommandRunner,
  publicSafeErrorFromUnknown,
  runExternalCommand,
  type StationBuildInfo,
  shellQuote,
  stationBuildInfo,
} from "@station/runtime";
import type { CliRunResult } from "../cliTypes.js";
import type { CliEnv } from "../env.js";
import type { ExecutableArgv } from "../selfExec.js";
import {
  createUpdateChannelProbe,
  type PlannedUpdateChannel,
  selectUpdateChannel,
  type UpdateChannelProbe,
} from "../update/channelDetection.js";
import { createDevCheckoutUpdateChannel } from "../update/devCheckoutUpdate.js";
import { createHomebrewUpdateChannel } from "../update/homebrewUpdate.js";
import { createInstallerBinaryUpdateChannel } from "../update/installerBinaryUpdate.js";
import { createMiseUpdateChannel } from "../update/miseUpdate.js";
import { createNpmGlobalUpdateChannel } from "../update/npmGlobalUpdate.js";
import {
  type UpdateApplyReportBase,
  type UpdateChannelId,
  type UpdateCommandArgv,
  updateChannelIds,
} from "../update/updateChannel.js";
import { updateErrorFromUnknown } from "../update/updateError.js";
import { type HostCommandDeps, runHostCommand } from "./host/index.js";

type UpdateStepStatus = "completed" | "planned" | "deferred" | "skipped" | "failed";

export type UpdateCommandStep = {
  id: "detect" | "plan" | "apply" | "observer-restart" | "host-handoff";
  status: UpdateStepStatus;
  detail: string;
  command?: UpdateCommandArgv;
};

export type UpdateCommandReport = {
  schemaVersion: 1;
  channel: UpdateChannelId;
  status: "current" | "planned" | "updated" | "deferred" | "failed";
  current: { version: string; revision?: string };
  target: { version: string; revision?: string };
  steps: UpdateCommandStep[];
  warnings: SafeError[];
  recoveryCommands: UpdateCommandArgv[];
  error?: SafeError;
};

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

/**
 * ADAPTER
 *
 * Composes install-channel selection, mutation, and fresh-build runtime crossover for the CLI.
 */
export async function runUpdateCommand(
  args: readonly string[],
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<CliRunResult> {
  const parsed = parseUpdateArgs(args);
  const buildInfo = deps.buildInfo ?? stationBuildInfo;
  const runtimePath = deps.executablePath ?? process.execPath;
  const probes =
    deps.probes ??
    defaultUpdateProbes({
      buildInfo,
      cliEntryPath: options.cliEntryPath,
      runtimePath,
      ...(options.env?.PATH === undefined ? {} : { pathEnv: options.env.PATH }),
      ...(deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner }),
      ...(deps.executablePath === undefined ? {} : { executablePath: deps.executablePath }),
    });
  const selected = await selectUpdateChannel({
    probes,
    ...(parsed.channel === undefined ? {} : { requested: parsed.channel }),
  });
  const report = baseReport(selected);
  const managerOwned = selected.plan.managerCommand !== undefined;
  if (parsed.drivePackageManager && !managerOwned) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_FLAG_INVALID",
      message: "--drive-package-manager requires a Homebrew, npm-global, or mise channel.",
    });
  }

  if (selected.plan.status === "current") {
    report.status = "current";
    report.steps.push(
      step("apply", "skipped", "The selected installation already matches its target."),
      step("observer-restart", "skipped", "No build changed."),
      step("host-handoff", "skipped", "No build changed."),
    );
    return commandResult(report, parsed.json);
  }

  const mutationRequested = !managerOwned || parsed.drivePackageManager;
  const hostPreflight =
    parsed.handoff === undefined || !mutationRequested
      ? ({ action: "skip" } as const)
      : await preflightHostHandoff(selected, parsed.handoff, options, deps.hostDeps);

  if (parsed.dryRun) {
    report.status = "planned";
    report.steps.push(
      managerOwned && !parsed.drivePackageManager
        ? step(
            "apply",
            "deferred",
            "The package manager owns mutation; rerun with --drive-package-manager to execute it.",
            selected.plan.managerCommand,
          )
        : step(
            "apply",
            "planned",
            "The selected channel would apply the planned update.",
            selected.plan.managerCommand,
          ),
      mutationRequested
        ? step("observer-restart", "planned", "The new launcher would restart the Observer.")
        : step("observer-restart", "skipped", "No Station build would be installed."),
      hostPreflight.action === "handoff"
        ? step(
            "host-handoff",
            "planned",
            `The new launcher would hand off ${parsed.handoff} state.`,
          )
        : step(
            "host-handoff",
            "skipped",
            parsed.handoff === undefined
              ? "Host handoff was not requested."
              : "No live Host handoff is needed.",
          ),
    );
    return commandResult(report, parsed.json);
  }

  let applied: UpdateApplyReportBase;
  try {
    applied = await selected.apply({ drivePackageManager: parsed.drivePackageManager });
  } catch (error) {
    return failedResult(
      report,
      "apply",
      error,
      retryUpdateCommand(selected.plan.currentCli, options.configPath, parsed),
      parsed.json,
    );
  }
  report.warnings.push(...applied.warnings);
  if (applied.status === "deferred") {
    report.status = "deferred";
    report.steps.push(
      step(
        "apply",
        "deferred",
        "The package manager owns mutation and no manager command was executed.",
        selected.plan.managerCommand,
      ),
      step("observer-restart", "skipped", "No Station build was installed."),
      step("host-handoff", "skipped", "No Station build was installed."),
    );
    return commandResult(report, parsed.json);
  }
  report.steps.push(step("apply", "completed", `Installed Station ${applied.installedVersion}.`));

  const successorCli = applied.successorCli;
  if (successorCli === undefined) {
    return failedResult(
      report,
      "observer-restart",
      updateErrorFromUnknown(undefined, {
        code: "UPDATE_CROSSOVER_INVALID",
        message: "The update committed without identifying its successor Station launcher.",
      }),
      retryUpdateCommand(selected.plan.currentCli, options.configPath, parsed),
      parsed.json,
    );
  }

  const observerCommand = stationCommand(successorCli, options.configPath, ["observer", "restart"]);
  try {
    await runCrossover(observerCommand, deps.commandRunner);
    report.steps.push(
      step("observer-restart", "completed", "The Observer is running from the installed build."),
    );
  } catch (error) {
    return failedResult(report, "observer-restart", error, observerCommand, parsed.json);
  }

  if (hostPreflight.action === "handoff" && parsed.handoff !== undefined) {
    const hostCommand = stationCommand(successorCli, options.configPath, [
      "host",
      "handoff",
      "--fidelity",
      parsed.handoff,
    ]);
    try {
      await runCrossover(hostCommand, deps.commandRunner);
      report.steps.push(
        step("host-handoff", "completed", `The Host completed ${parsed.handoff} handoff.`),
      );
    } catch (error) {
      return failedResult(report, "host-handoff", error, hostCommand, parsed.json);
    }
  } else {
    report.steps.push(
      step(
        "host-handoff",
        "skipped",
        parsed.handoff === undefined
          ? "Host handoff was not requested."
          : "No live Host handoff is needed.",
      ),
    );
  }
  report.status = "updated";
  return commandResult(report, parsed.json);
}

function defaultUpdateProbes(input: {
  buildInfo: () => StationBuildInfo;
  cliEntryPath: string;
  runtimePath: string;
  pathEnv?: string;
  commandRunner?: ExternalCommandRunner;
  executablePath?: string;
}): UpdateChannelProbe[] {
  const shared = {
    runtimePath: input.runtimePath,
    ...(input.pathEnv === undefined ? {} : { pathEnv: input.pathEnv }),
    ...(input.commandRunner === undefined ? {} : { commandRunner: input.commandRunner }),
  };
  return [
    createUpdateChannelProbe(
      createInstallerBinaryUpdateChannel({
        buildInfo: input.buildInfo,
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
        ...(input.commandRunner === undefined ? {} : { commandRunner: input.commandRunner }),
      }),
    ),
    createUpdateChannelProbe(
      createDevCheckoutUpdateChannel({
        cliEntryPath: input.cliEntryPath,
        buildInfo: input.buildInfo,
        ...shared,
      }),
    ),
    createUpdateChannelProbe(createHomebrewUpdateChannel(shared)),
    createUpdateChannelProbe(createNpmGlobalUpdateChannel(shared)),
    createUpdateChannelProbe(createMiseUpdateChannel(shared)),
  ];
}

function parseUpdateArgs(args: readonly string[]): {
  channel?: UpdateChannelId;
  dryRun: boolean;
  json: boolean;
  drivePackageManager: boolean;
  handoff?: HostHandoffFidelity;
} {
  let channel: UpdateChannelId | undefined;
  let dryRun = false;
  let json = false;
  let drivePackageManager = false;
  let handoff: HostHandoffFidelity | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--channel") {
      if (channel !== undefined) throw new Error("--channel may be provided only once.");
      const value = args[index + 1];
      if (!isUpdateChannelId(value)) throw new Error(updateUsage);
      channel = value;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may be provided only once.");
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      if (json) throw new Error("--json may be provided only once.");
      json = true;
      continue;
    }
    if (arg === "--drive-package-manager") {
      if (drivePackageManager) {
        throw new Error("--drive-package-manager may be provided only once.");
      }
      drivePackageManager = true;
      continue;
    }
    if (arg === "--handoff") {
      if (handoff !== undefined) throw new Error("--handoff may be provided only once.");
      handoff = "processes";
      continue;
    }
    if (arg?.startsWith("--handoff=")) {
      if (handoff !== undefined) throw new Error("--handoff may be provided only once.");
      const value = arg.slice("--handoff=".length);
      if (value !== "processes" && value !== "screen") throw new Error(updateUsage);
      handoff = value;
      continue;
    }
    throw new Error(updateUsage);
  }
  return {
    ...(channel === undefined ? {} : { channel }),
    dryRun,
    json,
    drivePackageManager,
    ...(handoff === undefined ? {} : { handoff }),
  };
}

const updateUsage =
  "Usage: stn update [--channel <installer-binary|dev-checkout|homebrew|npm-global|mise>] [--dry-run] [--json] [--drive-package-manager] [--handoff[=processes|screen]]";

function isUpdateChannelId(value: string | undefined): value is UpdateChannelId {
  return value !== undefined && updateChannelIds.some((channel) => channel === value);
}

function baseReport(selected: PlannedUpdateChannel): UpdateCommandReport {
  return {
    schemaVersion: 1,
    channel: selected.channel,
    status: "planned",
    current: artifact(selected.plan.currentVersion, selected.plan.currentRevision),
    target: artifact(selected.plan.targetVersion, selected.plan.targetRevision),
    steps: [
      step("detect", "completed", `Detected ${selected.channel} ownership.`),
      step("plan", "completed", "Resolved the current and target Station builds."),
    ],
    warnings: [],
    recoveryCommands: [],
  };
}

function artifact(version: string, revision: string | undefined) {
  return { version, ...(revision === undefined ? {} : { revision }) };
}

async function preflightHostHandoff(
  selected: PlannedUpdateChannel,
  fidelity: HostHandoffFidelity,
  options: UpdateCommandOptions,
  hostDeps: HostCommandDeps | undefined,
): Promise<{ action: "skip" } | { action: "handoff" }> {
  const targetDeps: HostCommandDeps = {
    ...hostDeps,
    expectedBuildVersion: selected.plan.targetVersion,
  };
  const status = await runHostCommand(["status"], { config: options.config }, targetDeps);
  if (status.action !== "status") throw new Error("Host status returned the wrong action.");
  if (status.probe === "absent" || status.probe === "stale") return { action: "skip" };
  if (status.probe !== "listening" || status.compatibility === undefined) {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
      message: "The active Station Host could not be inspected before update.",
      hint: "Run stn host status and resolve its reported socket error before retrying.",
    });
  }
  if (status.compatibility.action === "refuse") {
    throw updateErrorFromUnknown(undefined, {
      code: "UPDATE_HOST_HANDOFF_REFUSED",
      message: "The active Station Host protocol cannot hand off to the target build.",
      hint: "Finish or preserve the live terminals before upgrading without handoff.",
    });
  }
  if (status.compatibility.action === "reuse" || status.livePtyCount === 0) {
    return { action: "skip" };
  }
  const planned = await runHostCommand(
    ["handoff", "--dry-run", "--fidelity", fidelity],
    { config: options.config },
    targetDeps,
  );
  if (planned.action === "handoff" && planned.status === "planned") {
    return { action: "handoff" };
  }
  throw updateErrorFromUnknown(undefined, {
    code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED",
    message: "The active Station Host could not prepare a safe live handoff.",
    hint: planned.action === "handoff" ? planned.message : "Run stn host status before retrying.",
  });
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
  parsed: ReturnType<typeof parseUpdateArgs>,
): UpdateCommandArgv {
  return stationCommand(cli, configPath, [
    "update",
    ...(parsed.channel === undefined ? [] : ["--channel", parsed.channel]),
    ...(parsed.drivePackageManager ? ["--drive-package-manager"] : []),
    ...(parsed.handoff === undefined ? [] : [`--handoff=${parsed.handoff}`]),
  ]);
}

function failedResult(
  report: UpdateCommandReport,
  phase: UpdateCommandStep["id"],
  error: unknown,
  recoveryCommand: UpdateCommandArgv,
  json: boolean,
): CliRunResult {
  const safeError = publicSafeErrorFromUnknown(error, updateFailureFallback);
  report.status = "failed";
  report.error = safeError;
  report.recoveryCommands.push(recoveryCommand);
  report.steps.push(step(phase, "failed", safeError.message, recoveryCommand));
  if (phase === "apply") {
    report.steps.push(
      step("observer-restart", "skipped", "The update did not reach runtime crossover."),
      step("host-handoff", "skipped", "The update did not reach runtime crossover."),
    );
  } else if (phase === "observer-restart") {
    report.steps.push(step("host-handoff", "skipped", "Observer crossover failed first."));
  }
  return {
    code: 1,
    output: json ? report : renderUpdateReport(report),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

const updateFailureFallback = {
  tag: "UpdateError",
  code: "UPDATE_FAILED",
  message: "Station update failed.",
} as const;

function step(
  id: UpdateCommandStep["id"],
  status: UpdateStepStatus,
  detail: string,
  command?: UpdateCommandArgv,
): UpdateCommandStep {
  return { id, status, detail, ...(command === undefined ? {} : { command }) };
}

function commandResult(report: UpdateCommandReport, json: boolean): CliRunResult {
  return {
    code: report.status === "failed" ? 1 : 0,
    output: json ? report : renderUpdateReport(report),
    ...(json ? {} : { outputFormat: "text" as const }),
  };
}

export function renderUpdateReport(report: UpdateCommandReport): string {
  const lines = [
    `channel: ${report.channel}`,
    `status: ${report.status}`,
    `current: ${artifactText(report.current)}`,
    `target: ${artifactText(report.target)}`,
    "steps:",
  ];
  for (const item of report.steps) {
    lines.push(`  ${item.id}: ${item.status} - ${item.detail}`);
    if (item.command !== undefined) lines.push(`    ${formatCommand(item.command)}`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning.message}`);
  if (report.error !== undefined)
    lines.push(`error: ${report.error.message} (${report.error.code})`);
  if (report.recoveryCommands.length > 0) {
    lines.push("recovery:");
    for (const command of report.recoveryCommands) lines.push(`  ${formatCommand(command)}`);
  }
  return `${lines.join("\n")}\n`;
}

function artifactText(value: UpdateCommandReport["current"]): string {
  return value.revision === undefined ? value.version : `${value.version} (${value.revision})`;
}

function formatCommand(command: readonly string[]): string {
  return command.map((value) => shellQuote(value)).join(" ");
}
