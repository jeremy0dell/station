import {
  assessHarnessTracking,
  type SetupPlan as CoreSetupPlan,
  type HarnessSelectionFacts,
  type HarnessSelectionIntent,
  type HarnessTrackingFacts,
  planSetup,
  type SetupOperation,
  type SetupPlanningFacts,
  type SetupPlanningIntent,
} from "@station/setup-core";
import type { SetupOperationBinding } from "./apply.js";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  relevantHarnessTrackingIds,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "./harnessSelection.js";
import type { ConfigWritePlan, SetupFacts, SetupPlan, SupportedHarnessId } from "./model.js";
import { SetupHarnessTrackingFactSchema } from "./model.js";
import { projectCliSetupPlan } from "./presentation/projectCliSetupPlan.js";
import { type ProjectSetupView, projectSetupView } from "./presentation/projectSetupView.js";

export type BuildSetupPlanOptions = {
  configWrite?: ConfigWritePlan;
  harnessSelection?: SetupHarnessSelection;
  installWorktrunkHooks?: boolean;
};

export type BuiltSetupPlans = {
  readonly semanticPlan: CoreSetupPlan;
  readonly presentationView: ProjectSetupView;
  readonly compatibilityPlan: SetupPlan;
  readonly operationBindings: readonly SetupOperationBinding[];
};

export function buildSetupPlan(facts: SetupFacts, options: BuildSetupPlanOptions = {}): SetupPlan {
  return buildSetupPlans(facts, options).compatibilityPlan;
}

export function buildSetupPlans(
  facts: SetupFacts,
  options: BuildSetupPlanOptions = {},
): BuiltSetupPlans {
  SetupHarnessTrackingFactSchema.array().parse(facts.harnessTracking);
  const harnessSelection = options.harnessSelection ?? resolveSetupHarnessSelection(facts);
  const evidence = normalizeSetupPlanningFacts(facts, harnessSelection, options.configWrite);
  const intent: SetupPlanningIntent = {
    mode: facts.mode,
    harnessSelection: normalizeHarnessSelectionIntent(options.harnessSelection),
    installWorktrunkHooks: options.installWorktrunkHooks === true,
  };
  const semanticPlan = planSetup(evidence, intent);
  const projectionInput =
    options.configWrite === undefined
      ? { plan: semanticPlan, facts }
      : { plan: semanticPlan, facts, configWrite: options.configWrite };
  const presentationView = projectSetupView(projectionInput);
  const compatibilityPlan = projectCliSetupPlan(projectionInput);
  return {
    semanticPlan,
    presentationView,
    compatibilityPlan,
    operationBindings: bindSetupOperations(semanticPlan.operations),
  };
}

function bindSetupOperations(
  operations: readonly SetupOperation[],
): readonly SetupOperationBinding[] {
  const bindings: SetupOperationBinding[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "install-tool":
        bindings.push({ actionId: `install-${operation.tool}`, operation });
        break;
      case "link-launchers":
        bindings.push({ actionId: "link-station-launchers", operation });
        break;
      case "configure-worktrunk-shell":
        bindings.push({ actionId: "worktrunk-shell-integration", operation });
        break;
      case "configure-tmux-popup":
        bindings.push({
          actionId:
            operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding",
          operation,
        });
        break;
      case "prepare-worktrunk-tracking":
        bindings.push({ actionId: "worktrunk-hooks", operation });
        break;
      case "prepare-harness-tracking":
        bindings.push({ actionId: `${operation.harnessId}-hooks`, operation });
        break;
      case "write-config":
        bindings.push(
          { actionId: "mkdir-config-dir", operation },
          {
            actionId: operation.change === "create" ? "write-config" : "update-config",
            operation,
          },
        );
        break;
      case "activate-observer-config":
      case "install-harness":
      case "install-homebrew":
      case "install-xcode-command-line-tools":
        break;
    }
  }
  return bindings;
}

function normalizeSetupPlanningFacts(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  configWrite: ConfigWritePlan | undefined,
): SetupPlanningFacts {
  const configState = normalizeConfigState(facts);
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
      state: configState,
      write: normalizeConfigWrite(configWrite),
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
    harnessTracking: normalizeHarnessTracking(facts, harnessSelection),
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

function normalizeHarnessSelectionIntent(
  selection: SetupHarnessSelection | undefined,
): HarnessSelectionIntent {
  if (selection?.source === "explicit") {
    return { kind: "explicit", harnessIds: selection.requiredHarnessIds };
  }
  return { kind: "automatic" };
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

function normalizeConfigWrite(
  configWrite: ConfigWritePlan | undefined,
): SetupPlanningFacts["config"]["write"] {
  return configWrite?.operation ?? "none";
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
