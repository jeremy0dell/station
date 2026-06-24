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

export function isSupportedHarnessId(value: string): value is SupportedHarnessId {
  return supportedHarnessIds.some((id) => id === value);
}
