import { safeErrorFromUnknown } from "@station/runtime";
import {
  assessHarnessTracking,
  type HarnessSelectionFacts,
  type HarnessTrackingFacts,
  type SetupInspection,
  type SetupPlanningFacts,
  type SupportedHarnessId,
} from "@station/setup-core";
import { type CollectSetupFactsOptions, collectSetupFacts } from "../checks/system.js";
import { planSetupConfigWrite } from "../configWriter.js";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  relevantHarnessTrackingIds,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "../harnessSelection.js";
import type { ConfigWritePlan } from "../model.js";
import type { SetupCommandDeps, SetupCommandOptions } from "../types.js";
import type { SetupFacts, SetupHarnessTrackingFact, SetupMode } from "./inspectionTypes.js";
import { SetupHarnessTrackingFactSchema } from "./inspectionTypes.js";

export type SetupInspectionSnapshot = {
  readonly facts: SetupFacts;
  readonly planningFacts: SetupPlanningFacts;
  readonly harnessSelection: SetupHarnessSelection;
  readonly configWrite?: ConfigWritePlan;
};

export type SetupInspectionAdapter = SetupInspection & {
  readonly current: () => SetupInspectionSnapshot | undefined;
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
 * Collects CLI machine facts and provider-hook status, retaining representation-specific evidence locally while exposing normalized setup evidence to core.
 */
export function createSetupInspectionAdapter(
  options: SetupInspectionAdapterOptions,
): SetupInspectionAdapter {
  let snapshot: SetupInspectionSnapshot | undefined;

  const inspect: SetupInspection = async () => {
    try {
      const facts = await collectFacts(options);
      const harnessSelection = resolveSetupHarnessSelection(facts);
      const withTracking = await collectHarnessTrackingFacts(facts, harnessSelection, options.deps);
      const trackedHarnessIds =
        harnessSelection.requiredHarnessIds.filter(harnessSupportsSetupHooks);
      let configWrite: ConfigWritePlan | undefined;
      if (options.planConfigWrite) {
        configWrite = await planSetupConfigWrite(withTracking, {
          harnessSelection,
          installHarnessHooks: trackedHarnessIds,
        });
      }
      const planningFacts = normalizeSetupPlanningFacts(
        withTracking,
        harnessSelection,
        configWrite,
      );
      const next: SetupInspectionSnapshot =
        configWrite === undefined
          ? { facts: withTracking, planningFacts, harnessSelection }
          : { facts: withTracking, planningFacts, harnessSelection, configWrite };
      snapshot = next;
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

  return Object.assign(inspect, { current: () => snapshot });
}

async function collectFacts(options: SetupInspectionAdapterOptions): Promise<SetupFacts> {
  const collectOptions: CollectSetupFactsOptions = { mode: options.mode };
  const { deps, options: commandOptions } = options;
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
  collectOptions.noBrew = options.noBrew;
  return collectSetupFacts(collectOptions);
}

async function collectHarnessTrackingFacts(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  deps: SetupCommandDeps,
): Promise<SetupFacts> {
  const harnessTracking = await Promise.all(
    relevantHarnessTrackingIds(facts, harnessSelection).map((harnessId) =>
      probeHarnessTrackingFact(facts, harnessId, deps),
    ),
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
  selection: SetupHarnessSelection,
  configWrite: ConfigWritePlan | undefined,
): SetupPlanningFacts {
  return {
    generatedAt: facts.generatedAt,
    compiled: facts.compiled,
    stateDirectoryWritable: facts.stateDir.status === "ok",
    socketEvidenceAvailable: facts.socketEvidence.status === "ok",
    xcodeTools: normalizeXcodeTools(facts),
    tools: [
      normalizeTool("worktrunk", facts.worktrunk.status === "ok", facts),
      normalizeTool("tmux", facts.tmux.status === "ok", facts),
      normalizeTool("bun", facts.bun.status === "ok", facts),
      normalizeTool("diffnav", facts.diffnav.status === "ok", facts),
      normalizeTool("git-delta", facts.gitDelta.status === "ok", facts),
    ],
    runtimeUi: normalizeRuntimeUi(facts),
    git:
      facts.git.status === "missing"
        ? { state: "unusable", reason: facts.git.reason }
        : { state: "usable", repository: facts.git.repository },
    harnessSelection: normalizeHarnessSelectionFacts(facts),
    config: {
      state: normalizeConfigState(facts),
      write: configWrite?.operation ?? "none",
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
    worktrunkShell:
      facts.worktrunkShellIntegration.status === "ok"
        ? "ready"
        : facts.worktrunkShellIntegration.status === "warning"
          ? "missing"
          : "skipped",
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
  selection: SetupHarnessSelection,
): SetupPlanningFacts["harnessTracking"] {
  const requiredHarnessIds = new Set(selection.requiredHarnessIds);
  const persistedHarnessIds =
    facts.config.status === "valid" ? new Set(facts.config.configuredHookHarnesses) : new Set();
  return relevantHarnessTrackingIds(facts, selection).map((harnessId) => {
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
    isSupportedHarnessId(defaults.harness)
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

function normalizeTmuxLive(facts: SetupFacts): SetupPlanningFacts["tmuxPopup"]["live"] {
  if (!facts.tmuxBinding.insideTmux) return "not-applicable";
  switch (facts.tmuxBinding.liveStatus) {
    case "loaded":
      return "ready";
    case "missing":
      return "missing";
    case "unknown":
      return "unknown";
  }
}

function normalizeWorktrunkHooks(facts: SetupFacts): SetupPlanningFacts["worktrunkHooks"] {
  if (facts.worktrunk.status !== "ok") return "not-applicable";
  if (facts.config.status !== "valid" || facts.worktrunkAutomation.status === "warning") {
    return "missing";
  }
  return "ready";
}
