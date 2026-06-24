import type { HarnessRunObservation, HarnessStatusObservation } from "@station/contracts";
import { classifyHarnessRunStatus } from "@station/harness-shared";

export function classifyPiRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  return classifyHarnessRunStatus(run, {
    provider: "pi",
    fallbackReason: "Pi run has no reliable Pi status signal yet.",
    needsAttention: false,
  });
}
