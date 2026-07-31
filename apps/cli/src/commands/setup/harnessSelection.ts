import {
  type HarnessSelectionFacts,
  type HarnessSelectionIntent,
  type HarnessTrackingRepairFact,
  resolveHarnessSelection,
  selectHarnessTrackingRepairTargets,
  supportedHarnessIds,
} from "@station/setup-core";
import type {
  SetupFacts,
  SetupHarnessFact,
  SetupHarnessSelectionSource,
  SupportedHarnessId,
} from "./model.js";

export type SetupHarnessSelection = {
  selected: readonly SetupHarnessFact[];
  requiredHarnessIds: readonly SupportedHarnessId[];
  source: SetupHarnessSelectionSource;
  defaultHarness?: SupportedHarnessId;
};

export function resolveSetupHarnessSelection(
  facts: Pick<SetupFacts, "config" | "harnesses">,
  selectedIds?: readonly SupportedHarnessId[],
): SetupHarnessSelection {
  const resolution = resolveHarnessSelection(
    coreSelectionFacts(facts),
    selectionIntent(selectedIds),
  );
  if (resolution.outcome !== "selected") return unresolvedSelection();
  return {
    selected: availableHarnesses(facts.harnesses, resolution.requiredHarnessIds),
    requiredHarnessIds: resolution.requiredHarnessIds,
    source: resolution.source,
    defaultHarness: resolution.defaultHarness,
  };
}

function coreSelectionFacts(
  facts: Pick<SetupFacts, "config" | "harnesses">,
): HarnessSelectionFacts {
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

function selectionIntent(
  selectedIds: readonly SupportedHarnessId[] | undefined,
): HarnessSelectionIntent {
  return selectedIds === undefined
    ? { kind: "automatic" }
    : { kind: "explicit", harnessIds: selectedIds };
}

function unresolvedSelection(): SetupHarnessSelection {
  return { selected: [], requiredHarnessIds: [], source: "unresolved" };
}

export function isSupportedHarnessId(value: string): value is SupportedHarnessId {
  return supportedHarnessIds.some((id) => id === value);
}

export function harnessSupportsSetupHooks(
  harness: string,
): harness is "claude" | "codex" | "cursor" | "opencode" {
  return (
    harness === "claude" || harness === "codex" || harness === "cursor" || harness === "opencode"
  );
}

export function harnessTrackingRepairTargets(
  facts: Pick<SetupFacts, "config" | "harnesses" | "harnessTracking">,
  harnessSelection: SetupHarnessSelection,
): SetupHarnessFact[] {
  const persistedTrackingHarnessIds =
    facts.config.status === "valid" ? facts.config.configuredHookHarnesses : [];
  const harnesses: HarnessTrackingRepairFact[] = facts.harnesses.map((harness) => {
    const tracking = facts.harnessTracking.find((candidate) => candidate.harnessId === harness.id);
    return {
      id: harness.id,
      available: harness.status === "ok",
      capability: harnessSupportsSetupHooks(harness.id) ? "supported" : "unsupported",
      prepared:
        tracking?.capability === "supported" &&
        tracking.requested === true &&
        tracking.installed === true,
    };
  });
  const repairIds = selectHarnessTrackingRepairTargets({
    requiredHarnessIds: harnessSelection.requiredHarnessIds,
    persistedTrackingHarnessIds,
    harnesses,
  });
  return availableHarnesses(facts.harnesses, repairIds);
}

export function relevantHarnessTrackingIds(
  facts: Pick<SetupFacts, "config" | "harnesses">,
  harnessSelection: SetupHarnessSelection,
): SupportedHarnessId[] {
  const configuredIds =
    facts.config.status === "valid"
      ? [facts.config.defaults.harness, ...facts.config.configuredHarnesses]
      : [];
  return uniqueSupportedIds([...harnessSelection.requiredHarnessIds, ...configuredIds]).filter(
    (id) => facts.harnesses.some((harness) => harness.id === id),
  );
}

function uniqueSupportedIds(ids: readonly string[]): SupportedHarnessId[] {
  return ids.filter(isSupportedHarnessId).filter((id, index, all) => all.indexOf(id) === index);
}

function availableHarnesses(
  harnesses: readonly SetupHarnessFact[],
  ids: readonly SupportedHarnessId[],
): SetupHarnessFact[] {
  return ids.flatMap((id) => {
    const harness = harnesses.find((candidate) => candidate.id === id && candidate.status === "ok");
    return harness === undefined ? [] : [harness];
  });
}
