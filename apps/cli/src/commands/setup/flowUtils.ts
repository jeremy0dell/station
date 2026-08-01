import type { SafeError } from "@station/contracts";
import { type RuntimeSafeError, safeErrorFromUnknown } from "@station/runtime";
import type { SetupPlan as CoreSetupPlan, SetupOperationExecutor } from "@station/setup-core";
import type { CliEnv } from "../../env.js";
import { createSetupOperationAdapter } from "./adapters/operations.js";
import type { applySetupPlan, SetupOperationBinding } from "./apply.js";
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
import { setupPresenter } from "./io.js";
import type {
  SetupAction,
  SetupFacts,
  SetupHarnessTrackingFact,
  SetupMode,
  SetupPlan,
  SupportedHarnessId,
} from "./model.js";
import { SetupHarnessTrackingFactSchema } from "./model.js";
import { type buildSetupPlan, buildSetupPlans } from "./planner.js";
import type { ProjectSetupView } from "./presentation/projectSetupView.js";
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
  semanticPlan: CoreSetupPlan;
  presentationView: ProjectSetupView;
  operationBindings: readonly SetupOperationBinding[];
  executeOperation: SetupOperationExecutor;
};

type SetupPlanCollectionOptions = {
  selectedHarnessIds?: readonly SupportedHarnessId[];
  planConfigWrite?: boolean;
  installWorktrunkHooks?: boolean;
};

type CollectSetupPlanInput = SetupPlanCollectionOptions & {
  noBrew?: boolean;
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
  return collectSetupPlanFromFacts(baseFacts, deps, input);
}

export async function collectSetupPlanFromFacts(
  baseFacts: SetupFacts,
  deps: SetupCommandDeps,
  input: SetupPlanCollectionOptions = {},
): Promise<CollectedSetupPlan> {
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
  const built = buildSetupPlans(facts, plannerOptions);
  return {
    facts,
    harnessSelection,
    plan: built.compatibilityPlan,
    semanticPlan: built.semanticPlan,
    presentationView: built.presentationView,
    operationBindings: built.operationBindings,
    executeOperation: createSetupOperationAdapter({ facts, deps }),
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
    const fact: SetupHarnessTrackingFact = {
      harnessId,
      capability: "supported",
      requested: status.requested,
      installed: status.installed,
      detail: status.message,
    };
    if (status.ownership !== undefined) fact.ownership = status.ownership;
    return SetupHarnessTrackingFactSchema.parse(fact);
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
    execution?: Pick<CollectedSetupPlan, "operationBindings" | "executeOperation"> &
      Partial<Pick<CollectedSetupPlan, "presentationView">>;
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
  if (input.execution !== undefined) {
    options.operationBindings = input.execution.operationBindings;
    options.executeOperation = input.execution.executeOperation;
  }
  if (input.announceActions === true) {
    const presenter = setupPresenter(deps);
    // Execution uses compatibility actions, so borrow catalog labels from the independent human view by stable action ID.
    const progressAction = (action: SetupAction): Pick<SetupAction, "label"> => {
      const projected = input.execution?.presentationView?.actions.find(
        (candidate) => candidate.id === action.id,
      );
      return projected === undefined ? action : { label: presenter.text(projected.label) };
    };
    if (input.showCommandOutput === true) {
      options.onActionStart = async (action) => {
        await presenter.write(`${presenter.renderProgressStart(progressAction(action))}\n`);
      };
    }
    options.onActionComplete = async (action) => {
      if (action.kind === "mkdir") return;
      await presenter.write(`${presenter.renderProgressComplete(progressAction(action))}\n`);
    };
    options.onActionFailed = async (action, error) => {
      await presenter.write(`${presenter.renderProgressFailure(progressAction(action), error)}\n`);
    };
  }
  return options;
}

export async function activateCompletedConfigWrite(
  collected: Pick<CollectedSetupPlan, "semanticPlan" | "executeOperation" | "facts">,
  deps: SetupCommandDeps,
): Promise<SafeError | undefined> {
  const operation = collected.semanticPlan.operations.find(
    (candidate) => candidate.kind === "activate-observer-config",
  );
  if (operation === undefined) return undefined;

  const presenter = setupPresenter(deps);
  await presenter.write(`${presenter.renderActivationStart()}\n`);
  const outcome = await collected.executeOperation(operation);
  if (outcome.status === "completed") {
    await presenter.write(`${presenter.renderActivationComplete()}\n`);
    return undefined;
  }
  const configPath = collected.facts.configPath;
  await presenter.write(
    presenter.renderActivationFailure(outcome.error, {
      restart: ["stn", "--config", configPath, "observer", "restart"],
      setup: ["stn", "--config", configPath, "setup", "apply", "--yes"],
    }),
  );
  return outcome.error;
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
