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
  const configuredDefault =
    facts.config.status === "valid" && isSupportedHarnessId(facts.config.defaults.harness)
      ? facts.config.defaults.harness
      : undefined;

  if (selectedIds !== undefined) {
    if (facts.config.status === "valid" && configuredDefault === undefined) {
      return { selected: [], requiredHarnessIds: [], source: "unresolved" };
    }
    const explicitIds = uniqueSupportedIds(selectedIds);
    if (explicitIds.length === 0) {
      return { selected: [], requiredHarnessIds: [], source: "unresolved" };
    }
    const firstExplicit = explicitIds[0];
    if (firstExplicit === undefined) {
      return { selected: [], requiredHarnessIds: [], source: "unresolved" };
    }
    const requiredHarnessIds =
      configuredDefault === undefined || explicitIds.includes(configuredDefault)
        ? explicitIds
        : [...explicitIds, configuredDefault];
    const selection: SetupHarnessSelection = {
      selected: availableHarnesses(facts.harnesses, requiredHarnessIds),
      requiredHarnessIds,
      source: "explicit",
      defaultHarness: configuredDefault ?? firstExplicit,
    };
    return selection;
  }

  if (facts.config.status === "valid") {
    if (configuredDefault === undefined) {
      return { selected: [], requiredHarnessIds: [], source: "unresolved" };
    }
    return {
      selected: availableHarnesses(facts.harnesses, [configuredDefault]),
      requiredHarnessIds: [configuredDefault],
      source: "configured",
      defaultHarness: configuredDefault,
    };
  }

  if (facts.config.status === "missing") {
    const available = facts.harnesses.filter((harness) => harness.status === "ok");
    if (available.length === 1) {
      const inferred = available[0];
      if (inferred !== undefined) {
        return {
          selected: [inferred],
          requiredHarnessIds: [inferred.id],
          source: "inferred",
          defaultHarness: inferred.id,
        };
      }
    }
  }

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
