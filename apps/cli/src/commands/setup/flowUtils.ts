import { loadConfig, resolveObserverPaths } from "@station/config";
import { type RuntimeSafeError, safeErrorFromUnknown } from "@station/runtime";
import type { CliEnv } from "../../env.js";
import { restartObserver } from "../../observerProcess.js";
import type { applySetupPlan } from "./apply.js";
import { commandEnv } from "./checks/env.js";
import {
  type CollectSetupFactsOptions,
  collectSetupFacts,
  type SetupDependencyCheckOptions,
} from "./checks/system.js";
import { planSetupConfigWrite } from "./configWriter.js";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  relevantHarnessTrackingIds,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "./harnessSelection.js";
import { renderOptions, write } from "./io.js";
import type {
  SetupAction,
  SetupFacts,
  SetupHarnessTrackingFact,
  SetupMode,
  SetupPlan,
  SupportedHarnessId,
} from "./model.js";
import { SetupHarnessTrackingFactSchema } from "./model.js";
import { buildSetupPlan } from "./planner.js";
import {
  formatCommand,
  renderActionComplete,
  renderActionFailed,
  renderActionStart,
} from "./render.js";
import type { SetupCommandDeps, SetupCommandOptions } from "./types.js";

export function collectForCommand(
  mode: SetupMode,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { noBrew?: boolean },
): Promise<SetupFacts> {
  const collectOptions: CollectSetupFactsOptions = { mode };
  if (options.configPath !== undefined) collectOptions.configPath = options.configPath;
  if (deps.cwd !== undefined) collectOptions.cwd = deps.cwd;
  if (deps.homeDir !== undefined) collectOptions.homeDir = deps.homeDir;
  const env = deps.env ?? options.env;
  if (env !== undefined) collectOptions.env = env;
  if (deps.runner !== undefined) collectOptions.runner = deps.runner;
  if (deps.access !== undefined) collectOptions.access = deps.access;
  if (deps.fs !== undefined) collectOptions.fs = deps.fs;
  if (deps.now !== undefined) collectOptions.now = deps.now;
  if (deps.platform !== undefined) collectOptions.platform = deps.platform;
  if (deps.compiled !== undefined) collectOptions.compiled = deps.compiled;
  if (deps.providerHookIngressLauncher !== undefined) {
    collectOptions.providerHookIngressLauncher = deps.providerHookIngressLauncher;
  }
  if (deps.tmuxPopupOwnerRoot !== undefined) {
    collectOptions.tmuxPopupOwnerRoot = deps.tmuxPopupOwnerRoot;
  }
  if (deps.stateDirExecute !== undefined) collectOptions.stateDirExecute = deps.stateDirExecute;
  if (deps.stateDirFs !== undefined) collectOptions.stateDirFs = deps.stateDirFs;
  if (flags.noBrew !== undefined) collectOptions.noBrew = flags.noBrew;
  return collectSetupFacts(collectOptions);
}

export type CollectedSetupPlan = {
  facts: SetupFacts;
  harnessSelection: SetupHarnessSelection;
  plan: SetupPlan;
};

type CollectSetupPlanInput = {
  noBrew?: boolean;
  selectedHarnessIds?: readonly SupportedHarnessId[];
  planConfigWrite?: boolean;
  installWorktrunkHooks?: boolean;
};

export async function collectSetupPlanForCommand(
  mode: SetupMode,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  input: CollectSetupPlanInput = {},
): Promise<CollectedSetupPlan> {
  const baseFacts = await collectForCommand(mode, options, deps, {
    ...(input.noBrew === undefined ? {} : { noBrew: input.noBrew }),
  });
  const harnessSelection = resolveSetupHarnessSelection(baseFacts, input.selectedHarnessIds);
  const facts = await collectHarnessTrackingFacts(baseFacts, harnessSelection, deps);
  const trackedHarnessIds = harnessSelection.requiredHarnessIds.filter(harnessSupportsSetupHooks);
  const plannerOptions: Parameters<typeof buildSetupPlan>[1] = { harnessSelection };
  if (input.installWorktrunkHooks !== undefined) {
    plannerOptions.installWorktrunkHooks = input.installWorktrunkHooks;
  }
  if (input.planConfigWrite === true) {
    plannerOptions.configWrite = await planSetupConfigWrite(facts, {
      harnessSelection,
      installHarnessHooks: trackedHarnessIds,
      ...(input.installWorktrunkHooks === undefined
        ? {}
        : { installWorktrunkHooks: input.installWorktrunkHooks }),
    });
  }
  return {
    facts,
    harnessSelection,
    plan: buildSetupPlan(facts, plannerOptions),
  };
}

async function collectHarnessTrackingFacts(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  deps: SetupCommandDeps,
): Promise<SetupFacts> {
  const harnessIds = relevantHarnessTrackingIds(facts, harnessSelection);
  const harnessTracking = await Promise.all(
    harnessIds.map((harnessId) => probeHarnessTrackingFact(facts, harnessId, deps)),
  );
  return { ...facts, harnessTracking };
}

async function probeHarnessTrackingFact(
  facts: SetupFacts,
  harnessId: SupportedHarnessId,
  deps: SetupCommandDeps,
): Promise<SetupHarnessTrackingFact> {
  if (!harnessSupportsSetupHooks(harnessId)) {
    return SetupHarnessTrackingFactSchema.parse({
      harnessId,
      capability: "unsupported",
      detail: "This harness has no Station-managed external tracking artifact.",
    });
  }
  if (facts.config.status !== "valid") {
    return SetupHarnessTrackingFactSchema.parse({
      harnessId,
      capability: "supported",
      requested: false,
      detail: "Station config does not currently request tracking artifacts.",
    });
  }
  try {
    if (deps.probeHarnessHooksStatus === undefined) {
      throw setupHarnessProbeUnavailable;
    }
    const status = await deps.probeHarnessHooksStatus(harnessId, facts.config.path);
    if (status === undefined) {
      throw setupHarnessProbeUnavailable;
    }
    return SetupHarnessTrackingFactSchema.parse({
      harnessId,
      capability: "supported",
      requested: status.requested,
      installed: status.installed,
      detail: status.message,
    });
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, setupHarnessProbeFailed);
    return SetupHarnessTrackingFactSchema.parse({
      harnessId,
      capability: "supported",
      detail: `${safeError.message} (${safeError.code})`,
      probeFailed: true,
    });
  }
}

const setupHarnessProbeUnavailable: RuntimeSafeError = {
  tag: "SetupHarnessTrackingError",
  code: "SETUP_HARNESS_TRACKING_PROBE_UNAVAILABLE",
  message: "Harness tracking status probe is unavailable.",
};

const setupHarnessProbeFailed: RuntimeSafeError = {
  tag: "SetupHarnessTrackingError",
  code: "SETUP_HARNESS_TRACKING_PROBE_FAILED",
  message: "Harness tracking status could not be inspected.",
};

export function applyOptions(
  deps: SetupCommandDeps,
  input: {
    dryRun?: boolean;
    actionFilter?: (action: SetupAction) => boolean;
    showCommandOutput?: boolean;
    announceActions?: boolean;
  },
): Parameters<typeof applySetupPlan>[1] {
  const options: Parameters<typeof applySetupPlan>[1] = {};
  if (deps.runner !== undefined) options.runner = deps.runner;
  if (deps.fs !== undefined) options.fs = deps.fs;
  // Run spawned actions with deps.env so a brew-augmented PATH reaches `brew install`.
  const env = commandEnv(deps.env);
  if (env !== undefined) options.env = env;
  if (deps.now !== undefined) options.now = deps.now;
  if (input.dryRun !== undefined) options.dryRun = input.dryRun;
  if (input.actionFilter !== undefined) options.actionFilter = input.actionFilter;
  if (input.showCommandOutput !== undefined) options.showCommandOutput = input.showCommandOutput;
  if (input.announceActions === true) {
    options.onActionStart = async (action) => {
      await write(deps, `${renderActionStart(action, renderOptions(deps))}\n`);
    };
    options.onActionComplete = async (action) => {
      await write(deps, `${renderActionComplete(action, renderOptions(deps))}\n`);
    };
    options.onActionFailed = async (action) => {
      await write(deps, `${renderActionFailed(action, renderOptions(deps))}\n`);
    };
  }
  return options;
}

export async function activateCompletedConfigWrite(
  plan: SetupPlan,
  homeDir: string,
  deps: SetupCommandDeps,
): Promise<RuntimeSafeError | undefined> {
  const completedWrite = plan.actions.find(
    (action) => action.kind === "write-config" && action.status === "completed",
  );
  if (completedWrite === undefined) {
    return undefined;
  }

  await write(deps, "Activating observer configuration...\n");
  try {
    if (completedWrite.path === undefined) {
      throw observerActivationError;
    }
    await (deps.activateObserverConfig ?? activateObserverConfig)({
      configPath: completedWrite.path,
      homeDir,
    });
    await write(deps, "Observer configuration active.\n");
    return undefined;
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, observerActivationError);
    await write(deps, renderObserverActivationFailure(safeError, completedWrite.path));
    return safeError;
  }
}

async function activateObserverConfig(input: {
  configPath: string;
  homeDir: string;
}): Promise<void> {
  try {
    const loaded = await loadConfig({ configPath: input.configPath, homeDir: input.homeDir });
    const paths = resolveObserverPaths(loaded.config, input.homeDir);
    const status = await restartObserver({
      config: loaded.config,
      configPath: loaded.configPath,
      paths,
    });
    if (status.status !== "running") {
      throw safeErrorFromUnknown(status.error, observerActivationError);
    }
  } catch (error) {
    throw safeErrorFromUnknown(error, observerActivationError);
  }
}

const observerActivationError: RuntimeSafeError = {
  tag: "ObserverActivationError",
  code: "OBSERVER_ACTIVATION_FAILED",
  message: "Observer configuration could not be activated.",
};

function renderObserverActivationFailure(
  error: RuntimeSafeError,
  configPath: string | undefined,
): string {
  const lines = [
    "Config was written, but observer activation failed.",
    error.message,
    `Code: ${error.code}`,
  ];
  if (error.hint !== undefined) {
    lines.push(`Hint: ${error.hint}`);
  }
  const restartCommand =
    configPath === undefined
      ? formatCommand(["stn", "observer", "restart"])
      : formatCommand(["stn", "--config", configPath, "observer", "restart"]);
  const setupCommand =
    configPath === undefined
      ? formatCommand(["stn", "setup", "apply", "--yes"])
      : formatCommand(["stn", "--config", configPath, "setup", "apply", "--yes"]);
  lines.push(
    "The config is saved; remaining setup actions were not applied.",
    "Resolve the error above, then activate it with:",
    `Run: ${restartCommand}`,
    `Then rerun: ${setupCommand}`,
    "",
  );
  return lines.join("\n");
}

const brewBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

export function depsWithBrewBinPath(deps: SetupCommandDeps): SetupCommandDeps {
  const env = { ...(deps.env ?? process.env) };
  env.PATH = brewBinDirs.reduce((path, dir) => appendPath(path, dir), env.PATH);
  return { ...deps, env };
}

function appendPath(existing: string | undefined, path: string): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${existing}:${path}`;
}

export function dependencyOptionsForCommand(
  deps: SetupCommandDeps,
  env: CliEnv | undefined,
): SetupDependencyCheckOptions {
  const options: SetupDependencyCheckOptions = {};
  if (env !== undefined) options.env = env;
  if (deps.runner !== undefined) options.runner = deps.runner;
  if (deps.access !== undefined) options.access = deps.access;
  return options;
}

export function isInstallAction(action: SetupAction): boolean {
  return action.kind === "brew-install";
}

export function isConfigAction(action: SetupAction): boolean {
  return action.kind === "mkdir" || action.kind === "write-config";
}

export function isHookSetupAction(action: SetupAction): boolean {
  return action.data?.setupRole === "hook";
}

export function isTmuxPopupBindingAction(action: SetupAction): boolean {
  return action.id === "tmux-popup-binding" || action.id === "tmux-live-popup-binding";
}

export function markRequiredIncomplete(plan: SetupPlan): SetupPlan {
  return {
    ...plan,
    summary: {
      ...plan.summary,
      workflowReady: false,
      requiredOk: false,
      requiredMissing: Math.max(1, plan.summary.requiredMissing),
    },
  };
}

export function coreReadyForConfigWrite(plan: SetupPlan): boolean {
  // Tracking may be missing before config activation only when this plan owns its selected repair.
  const blockingCheck = plan.checks.find(
    (check) => isMissingRequiredCheck(check) && !canRepairAfterConfigWrite(check.id, plan.actions),
  );
  if (blockingCheck !== undefined) return false;

  const configCheck = plan.checks.find((check) => check.id === "config");
  if (configCheck?.status === "ok") return true;
  return (
    configCheck?.status === "missing" &&
    plan.actions.some((action) => isConfigAction(action) && action.selected)
  );
}

function isMissingRequiredCheck(check: SetupPlan["checks"][number]): boolean {
  return check.tier === "required" && check.id !== "config" && check.status !== "ok";
}

function canRepairAfterConfigWrite(checkId: string, actions: readonly SetupAction[]): boolean {
  const trackingPrefix = "harness-tracking:";
  if (!checkId.startsWith(trackingPrefix)) return false;
  const harnessId = checkId.slice(trackingPrefix.length);
  if (!isSupportedHarnessId(harnessId)) return false;
  return actions.some(
    (action) =>
      action.selected && action.data?.setupRole === "hook" && action.data.harness === harnessId,
  );
}
