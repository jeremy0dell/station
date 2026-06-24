import type { HarnessRunObservation, HarnessStatusObservation } from "@station/contracts";
import { classifyHarnessRunStatus } from "@station/harness-shared";

export function classifyCodexRunStatus(run: HarnessRunObservation): HarnessStatusObservation {
  return classifyHarnessRunStatus(run, {
    provider: "codex",
    fallbackReason: "Codex run has no reliable Codex status signal yet.",
  });
}
