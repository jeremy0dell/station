import type {
  SetupFacts,
  SetupHarnessFact,
  SetupHarnessSelectionSource,
  SupportedHarnessId,
} from "./model.js";
import { supportedHarnessIds } from "./model.js";

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
  const configuredDefault = configuredDefaultHarness(facts);
  if (selectedIds !== undefined) {
    return resolveExplicitSelection(facts, selectedIds, configuredDefault);
  }
  if (facts.config.status === "valid") {
    if (configuredDefault === undefined) return unresolvedSelection();
    return {
      selected: availableHarnesses(facts.harnesses, [configuredDefault]),
      requiredHarnessIds: [configuredDefault],
      source: "configured",
      defaultHarness: configuredDefault,
    };
  }
  return inferSingleAvailableHarness(facts) ?? unresolvedSelection();
}

function configuredDefaultHarness(
  facts: Pick<SetupFacts, "config">,
): SupportedHarnessId | undefined {
  if (facts.config.status !== "valid") return undefined;
  return isSupportedHarnessId(facts.config.defaults.harness)
    ? facts.config.defaults.harness
    : undefined;
}

function resolveExplicitSelection(
  facts: Pick<SetupFacts, "config" | "harnesses">,
  selectedIds: readonly SupportedHarnessId[],
  configuredDefault: SupportedHarnessId | undefined,
): SetupHarnessSelection {
  if (facts.config.status === "valid" && configuredDefault === undefined) {
    return unresolvedSelection();
  }
  const explicitIds = uniqueSupportedIds(selectedIds);
  const firstExplicit = explicitIds[0];
  if (firstExplicit === undefined) return unresolvedSelection();

  // Explicit choices may extend an existing config, but cannot replace its authoritative default.
  const requiredHarnessIds =
    configuredDefault === undefined || explicitIds.includes(configuredDefault)
      ? explicitIds
      : [...explicitIds, configuredDefault];
  return {
    selected: availableHarnesses(facts.harnesses, requiredHarnessIds),
    requiredHarnessIds,
    source: "explicit",
    defaultHarness: configuredDefault ?? firstExplicit,
  };
}

function inferSingleAvailableHarness(
  facts: Pick<SetupFacts, "config" | "harnesses">,
): SetupHarnessSelection | undefined {
  if (facts.config.status !== "missing") return undefined;
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  const inferred = available.length === 1 ? available[0] : undefined;
  if (inferred === undefined) return undefined;
  return {
    selected: [inferred],
    requiredHarnessIds: [inferred.id],
    source: "inferred",
    defaultHarness: inferred.id,
  };
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
  facts: Pick<SetupFacts, "config" | "harnesses">,
  harnessSelection: SetupHarnessSelection,
): SetupHarnessFact[] {
  const persistedHookIds =
    facts.config.status === "valid" ? facts.config.configuredHookHarnesses : [];
  const repairIds = uniqueSupportedIds([
    ...harnessSelection.requiredHarnessIds,
    ...persistedHookIds,
  ]);
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
