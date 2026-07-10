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
import { renderOptions, write } from "./io.js";
import type { SetupAction, SetupFacts, SetupMode, SetupPlan } from "./model.js";
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
  if (flags.noBrew !== undefined) collectOptions.noBrew = flags.noBrew;
  return collectSetupFacts(collectOptions);
}

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
  lines.push(`Run: ${restartCommand}`, "");
  return lines.join("\n");
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

export function actionById(plan: SetupPlan, id: string): SetupAction | undefined {
  return plan.actions.find((action) => action.id === id);
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
      requiredOk: false,
      requiredMissing: Math.max(1, plan.summary.requiredMissing),
    },
  };
}

export function coreReadyForConfigWrite(plan: SetupPlan): boolean {
  const nonConfigMissing = plan.checks.some(
    (check) => check.tier === "required" && check.id !== "config" && check.status !== "ok",
  );
  if (nonConfigMissing) {
    return false;
  }
  const config = plan.checks.find((check) => check.id === "config");
  if (config?.status === "ok") {
    return true;
  }
  return (
    config?.status === "missing" &&
    plan.actions.some((action) => isConfigAction(action) && action.selected)
  );
}
