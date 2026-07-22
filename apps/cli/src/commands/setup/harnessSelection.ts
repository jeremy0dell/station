import type { SetupHarnessFact, SupportedHarnessId } from "./model.js";
import { supportedHarnessIds } from "./model.js";

export function selectSetupHarness(
  harnesses: readonly SetupHarnessFact[],
  selectedHarness?: SupportedHarnessId,
): SetupHarnessFact | undefined {
  if (selectedHarness !== undefined) {
    return harnesses.find((harness) => harness.id === selectedHarness && harness.status === "ok");
  }
  for (const id of supportedHarnessIds) {
    const harness = harnesses.find((candidate) => candidate.id === id && candidate.status === "ok");
    if (harness !== undefined) {
      return harness;
    }
  }
  return undefined;
}

export function selectSetupHarnesses(
  harnesses: readonly SetupHarnessFact[],
  selectedHarnesses?: readonly SupportedHarnessId[],
  selectedHarness?: SupportedHarnessId,
): SetupHarnessFact[] {
  const selected: SetupHarnessFact[] = [];
  for (const id of selectedHarnesses ?? (selectedHarness === undefined ? [] : [selectedHarness])) {
    const harness = harnesses.find((candidate) => candidate.id === id && candidate.status === "ok");
    if (harness !== undefined && !selected.some((candidate) => candidate.id === harness.id)) {
      selected.push(harness);
    }
  }
  if (selected.length > 0) return selected;
  if (selectedHarnesses !== undefined || selectedHarness !== undefined) return [];
  const fallback = selectSetupHarness(harnesses, selectedHarness);
  return fallback === undefined ? [] : [fallback];
}

export function isSupportedHarnessId(value: string): value is SupportedHarnessId {
  return supportedHarnessIds.some((id) => id === value);
}
