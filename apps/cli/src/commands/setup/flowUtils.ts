import type { CliEnv } from "../../env.js";
import type { applySetupPlan } from "./apply.js";
import {
  type CollectSetupFactsOptions,
  collectSetupFacts,
  type SetupDependencyCheckOptions,
} from "./checks/system.js";
import { renderOptions, write } from "./io.js";
import type { SetupAction, SetupFacts, SetupMode, SetupPlan } from "./model.js";
import { renderActionComplete, renderActionFailed, renderActionStart } from "./render.js";
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
