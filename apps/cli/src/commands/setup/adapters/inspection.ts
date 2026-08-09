import type { SetupConfigMutationPlan } from "@station/config";
import { CliSetupHarnessIdSchema } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";
import {
  assessHarnessTracking,
  type HarnessSelectionFacts,
  type HarnessSelectionResolution,
  type HarnessTrackingFacts,
  resolveHarnessSelection,
  type SetupInspection,
  type SetupOperationOutcome,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
  type SupportedHarnessId,
} from "@station/setup-core";
import { type CollectSetupFactsOptions, collectSetupFacts } from "../checks/system.js";
import { SETUP_HARNESS_DEFINITIONS } from "../harnessDefinitions.js";
import { setupToolDefinitions } from "../toolDefinitions.js";
import type { SetupCommandDeps, SetupCommandOptions } from "../types.js";
import { planSetupConfigMutationForInspection } from "./config.js";
import type { SetupFacts, SetupHarnessTrackingFact, SetupMode } from "./inspectionTypes.js";
import { SetupHarnessTrackingFactSchema } from "./inspectionTypes.js";

export type SetupInspectionSnapshot = {
  readonly facts: SetupFacts;
  readonly configMutation?: SetupConfigMutationPlan;
};

export type SetupInspectionAdapter = SetupInspection & {
  readonly current: () => SetupInspectionSnapshot | undefined;
  readonly currentDeps: () => SetupCommandDeps;
  readonly recordOperationOutcome: (outcome: SetupOperationOutcome) => void;
};

export type SetupInspectionAdapterOptions = {
  readonly mode: SetupMode;
  readonly options: SetupCommandOptions;
  readonly deps: SetupCommandDeps;
  readonly noBrew: boolean;
  readonly planConfigWrite: boolean;
};

/**
 * ADAPTER
 *
 * Collects CLI and provider evidence, resolves normalized harness intent, and plans read-only config mutations while retaining boundary representations locally.
 */
export function createSetupInspectionAdapter(
  options: SetupInspectionAdapterOptions,
): SetupInspectionAdapter {
  let snapshot: SetupInspectionSnapshot | undefined;
  let inspectionDeps = options.deps;

  const inspect: SetupInspection = async (request) => {
    try {
      const facts = await collectSetupFactsForCommand(
        options.mode,
        options.options,
        inspectionDeps,
        { noBrew: options.noBrew },
      );
      const selection = resolveIntentHarnessSelection(facts, request.intent);
      const withTracking = await collectHarnessTrackingFacts({
        facts,
        selection,
        deps: inspectionDeps,
      });
      const trackingHarnessIds = selectedHarnessIds(selection).filter(harnessSupportsSetupHooks);
      let configMutation: SetupConfigMutationPlan | undefined;
      if (options.planConfigWrite) {
        configMutation = await planSetupConfigMutationForInspection({
          facts: withTracking,
          selection,
          trackingIntent: {
            harnessIds: trackingHarnessIds,
            installWorktrunkHooks: request.intent.installWorktrunkHooks,
          },
        });
      }
      const planningFacts = normalizeSetupPlanningFacts(withTracking, selection, configMutation);
      snapshot =
        configMutation === undefined
          ? { facts: withTracking }
          : { facts: withTracking, configMutation };
      return { status: "completed", facts: planningFacts };
    } catch (error) {
      return {
        status: "failed",
        error: safeErrorFromUnknown(error, {
          tag: "SetupInspectionError",
          code: "SETUP_INSPECTION_FAILED",
          message: "Setup facts could not be inspected.",
        }),
      };
    }
  };

  return Object.assign(inspect, {
    current: () => snapshot,
    currentDeps: () => inspectionDeps,
    recordOperationOutcome(outcome: SetupOperationOutcome) {
      if (outcome.status === "completed" && outcome.commit.kind === "package-installer") {
        inspectionDeps = depsWithPackageBinPaths(
          inspectionDeps,
          snapshot?.facts.homeDir ?? options.deps.homeDir,
          options.options.env,
        );
      }
    },
  });
}

function resolveIntentHarnessSelection(
  facts: SetupFacts,
  intent: SetupPlanningIntent,
): HarnessSelectionResolution {
  return resolveHarnessSelection(normalizeHarnessSelectionFacts(facts), intent.harnessSelection);
}

export function collectSetupFactsForCommand(
  mode: SetupMode,
  commandOptions: SetupCommandOptions,
  deps: SetupCommandDeps,
  flags: { readonly noBrew?: boolean },
): Promise<SetupFacts> {
  const collectOptions: CollectSetupFactsOptions = { mode };
  if (commandOptions.configPath !== undefined)
    collectOptions.configPath = commandOptions.configPath;
  if (deps.cwd !== undefined) collectOptions.cwd = deps.cwd;
  if (deps.homeDir !== undefined) collectOptions.homeDir = deps.homeDir;
  const env = deps.env ?? commandOptions.env;
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

async function collectHarnessTrackingFacts(input: {
  readonly facts: SetupFacts;
  readonly selection: HarnessSelectionResolution;
  readonly deps: SetupCommandDeps;
}): Promise<SetupFacts> {
  const harnessTracking = await Promise.all(
    relevantHarnessTrackingIds({ facts: input.facts, selection: input.selection }).map(
      (harnessId) => probeHarnessTrackingFact(input.facts, harnessId, input.deps),
    ),
  );
  return { ...input.facts, harnessTracking };
}

function selectedHarnessIds(selection: HarnessSelectionResolution): readonly SupportedHarnessId[] {
  return selection.outcome === "selected" ? selection.requiredHarnessIds : [];
}

function relevantHarnessTrackingIds(input: {
  readonly facts: Pick<SetupFacts, "config" | "harnesses">;
  readonly selection: HarnessSelectionResolution;
}): SupportedHarnessId[] {
  const configuredHarnessIds =
    input.facts.config.status === "valid"
      ? [input.facts.config.defaults.harness, ...input.facts.config.configuredHarnesses].flatMap(
          (value) => {
            const parsed = CliSetupHarnessIdSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          },
        )
      : [];
  const harnessIds = [
    ...new Set([...selectedHarnessIds(input.selection), ...configuredHarnessIds]),
  ];
  return harnessIds.filter((harnessId) =>
    input.facts.harnesses.some((harness) => harness.id === harnessId),
  );
}

function harnessSupportsSetupHooks(harnessId: SupportedHarnessId): boolean {
  return SETUP_HARNESS_DEFINITIONS[harnessId].tracking === "external";
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
    if (deps.probeHarnessHooksStatus === undefined) throw setupHarnessProbeUnavailable;
    const status = await deps.probeHarnessHooksStatus(harnessId, facts.config.path);
    if (status === undefined) throw setupHarnessProbeUnavailable;
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

const brewBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

export function depsWithBrewBinPath(
  deps: SetupCommandDeps,
  fallbackEnv: SetupCommandOptions["env"] = process.env,
): SetupCommandDeps {
  const env = { ...(deps.env ?? fallbackEnv ?? process.env) };
  env.PATH = brewBinDirs.reduce((path, directory) => appendPath(path, directory), env.PATH);
  return { ...deps, env };
}

function depsWithPackageBinPaths(
  deps: SetupCommandDeps,
  homeDir: string | undefined,
  fallbackEnv: SetupCommandOptions["env"],
): SetupCommandDeps {
  const withBrew = depsWithBrewBinPath(deps, fallbackEnv);
  if (homeDir === undefined) return withBrew;
  const env = { ...(withBrew.env ?? fallbackEnv ?? process.env) };
  env.PATH = prependPath(`${homeDir}/.opencode/bin`, env.PATH);
  env.PATH = prependPath(`${homeDir}/.local/bin`, env.PATH);
  return { ...withBrew, env };
}

function appendPath(existing: string | undefined, path: string): string {
  if (existing === undefined || existing.length === 0) return path;
  return existing.split(":").includes(path) ? existing : `${existing}:${path}`;
}

function prependPath(path: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return path;
  return existing.split(":").includes(path) ? existing : `${path}:${existing}`;
}

const setupHarnessProbeUnavailable = {
  tag: "SetupHarnessTrackingError",
  code: "SETUP_HARNESS_TRACKING_PROBE_UNAVAILABLE",
  message: "Harness tracking status probe is unavailable.",
} as const;

const setupHarnessProbeFailed = {
  tag: "SetupHarnessTrackingError",
  code: "SETUP_HARNESS_TRACKING_PROBE_FAILED",
  message: "Harness tracking status could not be inspected.",
} as const;

export function normalizeSetupPlanningFacts(
  facts: SetupFacts,
  selection: HarnessSelectionResolution,
  configMutation: SetupConfigMutationPlan | undefined,
): SetupPlanningFacts {
  return {
    generatedAt: facts.generatedAt,
    compiled: facts.compiled,
    stateDirectoryWritable: facts.stateDir.status === "ok",
    socketEvidenceAvailable: facts.socketEvidence.status === "ok",
    xcodeTools: normalizeXcodeTools(facts),
    homebrew:
      facts.brew.status === "ok"
        ? "available"
        : facts.brew.status === "missing"
          ? "missing"
          : "skipped",
    tools: setupToolDefinitions.map(({ id, factKey }) =>
      normalizeTool(id, facts[factKey].status === "ok", facts),
    ),
    runtimeUi: normalizeRuntimeUi(facts),
    git:
      facts.git.status === "missing"
        ? { state: "unusable", reason: facts.git.reason }
        : { state: "usable", repository: facts.git.repository },
    harnessSelection: normalizeHarnessSelectionFacts(facts),
    installableHarnessIds: facts.harnesses.map((harness) => harness.id),
    config: {
      state: normalizeConfigState(facts),
      write: configMutation?.operation ?? "none",
      diagnostics:
        facts.config.status === "valid"
          ? (facts.config.diagnostics ?? []).map((diagnostic) => ({
              code: diagnostic.code,
              severity: diagnostic.severity,
            }))
          : [],
    },
    launchers: {
      station: normalizeLauncher(facts.launchers.station),
      ingress: normalizeLauncher(facts.launchers.ingress),
      tmuxPopup: normalizeLauncher(facts.launchers.tmuxPopup),
    },
    worktrunkAutomation:
      facts.worktrunkAutomation.status === "ok" ? "ready" : facts.worktrunkAutomation.status,
    worktrunkShell: normalizeWorktrunkShell(facts),
    tmuxPopup: {
      persisted: facts.tmuxBinding.status === "ok" ? "ready" : facts.tmuxBinding.status,
      live: normalizeTmuxLive(facts),
    },
    worktrunkHooks: normalizeWorktrunkHooks(facts),
    harnessTracking: normalizeHarnessTracking(facts, selection),
  };
}

function normalizeHarnessSelectionFacts(facts: SetupFacts): HarnessSelectionFacts {
  let config: HarnessSelectionFacts["config"];
  switch (facts.config.status) {
    case "missing":
      config = { status: "missing" };
      break;
    case "invalid":
      config = { status: "invalid" };
      break;
    case "valid":
      config = { status: "valid", defaultHarness: facts.config.defaults.harness };
      break;
    default:
      return assertNever(facts.config);
  }
  return {
    config,
    harnesses: facts.harnesses.map((harness) => ({
      id: harness.id,
      availability: harness.status === "ok" ? "available" : "unavailable",
    })),
  };
}

function normalizeHarnessTracking(
  facts: SetupFacts,
  selection: HarnessSelectionResolution,
): SetupPlanningFacts["harnessTracking"] {
  const requiredHarnessIds = new Set(selectedHarnessIds(selection));
  const persistedHarnessIds =
    facts.config.status === "valid" ? new Set(facts.config.configuredHookHarnesses) : new Set();
  return relevantHarnessTrackingIds({ facts, selection }).map((harnessId) => {
    const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
    return {
      harnessId,
      assessment: assessHarnessTracking(coreHarnessTrackingFacts(facts, harnessId, fact)),
      required: requiredHarnessIds.has(harnessId),
      persistedIntent: persistedHarnessIds.has(harnessId),
    };
  });
}

function coreHarnessTrackingFacts(
  facts: SetupFacts,
  harnessId: SupportedHarnessId,
  fact: SetupFacts["harnessTracking"][number] | undefined,
): HarnessTrackingFacts {
  if (!harnessSupportsSetupHooks(harnessId)) {
    return {
      capability: "unsupported",
      configRequested: false,
      evidence: { availability: "unavailable" },
    };
  }
  const configRequested =
    facts.config.status === "valid" && facts.config.configuredHookHarnesses.includes(harnessId);
  if (fact === undefined || fact.capability !== "supported") {
    return {
      capability: "supported",
      configRequested,
      evidence: { availability: "unavailable" },
    };
  }
  const evidence: {
    availability: "available";
    requested?: boolean;
    installed?: boolean;
    probeFailed: boolean;
  } = {
    availability: "available",
    probeFailed: fact.probeFailed === true,
  };
  if (fact.requested !== undefined) evidence.requested = fact.requested;
  if (fact.installed !== undefined) evidence.installed = fact.installed;
  return { capability: "supported", configRequested, evidence };
}

function normalizeConfigState(facts: SetupFacts): SetupPlanningFacts["config"]["state"] {
  if (facts.config.status !== "valid") return facts.config.status;
  const defaults = facts.config.defaults;
  return defaults.worktreeProvider === "worktrunk" &&
    defaults.terminal === "tmux" &&
    CliSetupHarnessIdSchema.safeParse(defaults.harness).success
    ? "valid"
    : "invalid";
}

function normalizeTool(
  id: SetupPlanningFacts["tools"][number]["id"],
  available: boolean,
  facts: SetupFacts,
): SetupPlanningFacts["tools"][number] {
  return { id, available, installerAvailable: facts.brew.status === "ok" };
}

function normalizeXcodeTools(facts: SetupFacts): SetupPlanningFacts["xcodeTools"] {
  if (facts.xcode.status === "missing") return "missing";
  return facts.xcode.applicable ? "available" : "not-applicable";
}

function normalizeRuntimeUi(facts: SetupFacts): SetupPlanningFacts["runtimeUi"] {
  if (facts.compiled || facts.stationUi.status === "skipped") return "not-applicable";
  return facts.stationUi.status === "installed" ? "available" : "missing";
}

function normalizeLauncher(
  launcher: SetupFacts["launchers"]["station"],
): SetupPlanningFacts["launchers"]["station"] {
  if (launcher.source === "checkout") return "checkout";
  if (launcher.source === "installed") return "installed";
  return launcher.status === "ok" ? "available" : "missing";
}

function normalizeWorktrunkShell(facts: SetupFacts): SetupPlanningFacts["worktrunkShell"] {
  const status = facts.worktrunkShellIntegration.status;
  switch (status) {
    case "ok":
      return "ready";
    case "warning":
      return "missing";
    case "skipped":
      return "skipped";
    default:
      return assertNever(status);
  }
}

function normalizeTmuxLive(facts: SetupFacts): SetupPlanningFacts["tmuxPopup"]["live"] {
  if (!facts.tmuxBinding.insideTmux) return "not-applicable";
  const liveStatus = facts.tmuxBinding.liveStatus;
  switch (liveStatus) {
    case "loaded":
      return "ready";
    case "missing":
      return "missing";
    case "unknown":
      return "unknown";
    default:
      return assertNever(liveStatus);
  }
}

function normalizeWorktrunkHooks(facts: SetupFacts): SetupPlanningFacts["worktrunkHooks"] {
  if (facts.worktrunk.status !== "ok") return "not-applicable";
  if (facts.config.status !== "valid" || facts.worktrunkAutomation.status === "warning") {
    return "missing";
  }
  return "ready";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported setup fact: ${String(value)}`);
}
