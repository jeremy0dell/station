import {
  checkWorktrunkDependency,
  missingWorktrunkAutomationFlagSupport,
  worktrunkAutomationMode,
} from "@station/worktrunk";
import type { SetupDependencyFact, SetupWorktrunkAutomationFact } from "../model.js";
import { setupProbeTimeoutMs } from "./constants.js";
import { setupEnv } from "./env.js";
import type { SetupDependencyCheckOptions } from "./system.js";

export async function checkSetupWorktrunk(
  options: SetupDependencyCheckOptions = {},
): Promise<SetupDependencyFact> {
  const env = setupEnv(options.env);
  const command = env.STATION_WORKTRUNK_BIN ?? "wt";
  const dependencyOptions: Parameters<typeof checkWorktrunkDependency>[0] = {
    command,
    timeoutMs: setupProbeTimeoutMs,
  };
  if (options.runner !== undefined) dependencyOptions.runner = options.runner;
  if (options.access !== undefined) dependencyOptions.access = options.access;
  if (env.PATH !== undefined) dependencyOptions.pathEnv = env.PATH;
  const status = await checkWorktrunkDependency(dependencyOptions);
  if (status.status === "available") {
    const fact: SetupDependencyFact = {
      status: "ok",
      command: status.attemptedCommand,
    };
    if (status.version !== undefined) fact.version = status.version;
    if (status.rawVersion !== undefined) fact.rawVersion = status.rawVersion;
    if (status.resolvedPath !== undefined) fact.resolvedPath = status.resolvedPath;
    return fact;
  }
  return {
    status: "missing",
    command: status.attemptedCommand,
    message: status.installHint,
    ...(status.resolvedPath === undefined ? {} : { resolvedPath: status.resolvedPath }),
  };
}

export async function checkSetupWorktrunkAutomation(input: {
  worktrunk: SetupDependencyFact;
  configReady: boolean;
  useLifecycleHooks?: boolean;
  runner?: SetupDependencyCheckOptions["runner"];
}): Promise<SetupWorktrunkAutomationFact> {
  const mode = worktrunkAutomationMode(input.useLifecycleHooks);
  if (!input.configReady) {
    return {
      status: "skipped",
      automationMode: mode.automationMode,
      message: "Skipped until STATION config is valid.",
    };
  }
  if (input.worktrunk.status !== "ok") {
    return {
      status: "skipped",
      automationMode: mode.automationMode,
      message: "Skipped until Worktrunk is available.",
    };
  }
  if (mode.flag === undefined) {
    return {
      status: "ok",
      automationMode: mode.automationMode,
      message: "Lifecycle hook automation uses Worktrunk defaults; no prompt flags are configured.",
    };
  }

  const command = input.worktrunk.resolvedPath ?? input.worktrunk.command;
  try {
    const missing = await missingWorktrunkAutomationFlagSupport({
      command,
      flag: mode.flag,
      timeoutMs: setupProbeTimeoutMs,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    });
    if (missing.length === 0) {
      return {
        status: "ok",
        automationMode: mode.automationMode,
        flag: mode.flag,
        message: setupAutomationMessage(mode.automationMode, mode.flag),
      };
    }
    return {
      status: "warning",
      automationMode: mode.automationMode,
      flag: mode.flag,
      missingSubcommands: missing,
      message: `Configured Worktrunk automation requires ${mode.flag}, but wt ${missing.join(
        " and ",
      )} help does not advertise it.`,
    };
  } catch {
    return {
      status: "warning",
      automationMode: mode.automationMode,
      flag: mode.flag,
      message: `Could not verify that the installed wt supports ${mode.flag} for automated Worktrunk mutations.`,
    };
  }
}

function setupAutomationMessage(
  automationMode: SetupWorktrunkAutomationFact["automationMode"],
  flag: "--no-hooks" | "--yes",
): string {
  if (automationMode === "skip-hooks") {
    return `Lifecycle hooks are disabled; automated Worktrunk mutations pass ${flag}; installed wt supports this flag for switch and remove.`;
  }
  return `Lifecycle hooks are enabled; automated Worktrunk mutations pass ${flag} to pre-approve prompts; installed wt supports this flag for switch and remove.`;
}
