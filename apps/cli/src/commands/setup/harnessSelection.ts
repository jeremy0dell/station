import type { SetupFacts, SetupHarnessFact, SupportedHarnessId } from "./model.js";
import { supportedHarnessIds } from "./model.js";

export type SetupHarnessSelection = {
  selected: readonly SetupHarnessFact[];
  defaultHarness: SupportedHarnessId | undefined;
};

export function resolveSetupHarnessSelection(
  facts: Pick<SetupFacts, "config" | "harnesses">,
  selectedIds?: readonly SupportedHarnessId[],
): SetupHarnessSelection {
  const configuredIds =
    facts.config.status === "valid"
      ? uniqueSupportedIds([facts.config.defaults.harness, ...facts.config.configuredHarnesses])
      : undefined;
  const requestedIds =
    selectedIds === undefined
      ? (configuredIds ?? firstAvailableId(facts.harnesses))
      : uniqueSupportedIds(selectedIds);
  const selected = requestedIds.flatMap((id) => {
    const harness = facts.harnesses.find(
      (candidate) => candidate.id === id && candidate.status === "ok",
    );
    return harness === undefined ? [] : [harness];
  });
  const configuredDefault =
    facts.config.status === "valid" && isSupportedHarnessId(facts.config.defaults.harness)
      ? facts.config.defaults.harness
      : undefined;
  return {
    selected,
    defaultHarness: configuredDefault ?? selected[0]?.id,
  };
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

function firstAvailableId(harnesses: readonly SetupHarnessFact[]): SupportedHarnessId[] {
  for (const id of supportedHarnessIds) {
    if (harnesses.some((harness) => harness.id === id && harness.status === "ok")) return [id];
  }
  return [];
}
