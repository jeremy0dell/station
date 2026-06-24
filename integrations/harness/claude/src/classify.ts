import type { HarnessRunObservation, HarnessStatusObservation } from "@station/contracts";
import { classifyHarnessRunStatus } from "@station/harness-shared";

export function classifyClaudeRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  return classifyHarnessRunStatus(run, {
    provider: "claude",
    fallbackReason: "Claude Code run has no reliable Claude status signal yet.",
  });
}
