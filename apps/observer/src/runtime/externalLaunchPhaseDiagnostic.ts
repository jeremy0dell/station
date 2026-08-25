import { writeFileSync } from "node:fs";
import { z } from "zod";

export const externalLaunchDiagnosticPhases = [
  "prepareEntered",
  "mutationEntered",
  "targetInventoryStarted",
  "targetInventoryCompleted",
  "harnessPreflightStarted",
  "harnessPreflightCompleted",
  "sessionPersistenceStarted",
  "sessionPersistenceCompleted",
  "workspaceOpenStarted",
  "workspaceOpenCompleted",
  "launchPlanStarted",
  "launchPlanCompleted",
  "hostProcessLaunchStarted",
  "hostProcessLaunchCompleted",
  "canonicalProjectionStarted",
  "canonicalProjectionCompleted",
  "prepareCompleted",
] as const;

export type ExternalLaunchDiagnosticPhase = (typeof externalLaunchDiagnosticPhases)[number];

type ExternalLaunchDiagnosticEvent = {
  phase: ExternalLaunchDiagnosticPhase;
  atMs: number;
};

const outputPathResult = z
  .string()
  .min(1)
  .safeParse(process.env.STATION_QUICK_SESSION_EXTERNAL_LAUNCH_PHASE_DIAGNOSTIC_PATH);
const outputPath = outputPathResult.success ? outputPathResult.data : undefined;
const events: ExternalLaunchDiagnosticEvent[] = [];

if (outputPath !== undefined) {
  process.once("exit", () => {
    if (events.length > 0) {
      writeFileSync(outputPath, `${JSON.stringify({ events })}\n`, "utf8");
    }
  });
}

/**
 * Records an Observer external-launch phase in memory; the strict diagnostic
 * artifact is written only during normal Observer process exit.
 */
export function markExternalLaunchDiagnosticPhase(phase: ExternalLaunchDiagnosticPhase): void {
  if (outputPath !== undefined) {
    events.push({ phase, atMs: performance.now() });
  }
}
