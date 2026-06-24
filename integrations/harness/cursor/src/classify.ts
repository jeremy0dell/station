import type { HarnessRunObservation, HarnessStatusObservation } from "@station/contracts";
import { classifyHarnessRunStatus } from "@station/harness-shared";

export function classifyCursorRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  return classifyHarnessRunStatus(run, {
    provider: "cursor",
    fallbackReason: "Cursor run has no reliable Cursor hook status signal yet.",
    exitedSource: "harness_event",
  });
}
