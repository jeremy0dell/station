import type { HarnessRunObservation, HarnessStatusObservation } from "@station/contracts";
import { classifyHarnessRunStatus } from "@station/harness-shared";

export function classifyOpenCodeRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  return classifyHarnessRunStatus(run, {
    provider: "opencode",
    fallbackReason: "OpenCode run has no reliable OpenCode status signal yet.",
  });
}
