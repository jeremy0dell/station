import { writeSync } from "node:fs";

export const MANAGED_LAUNCH_PHASE_DIAGNOSTIC_PREFIX =
  "__STATION_QUICK_SESSION_MANAGED_LAUNCH_PHASES__:";

export const managedLaunchDiagnosticPhases = [
  "hostedLaunchStarted",
  "commandCompleted",
  "worktreeObserved",
  "attemptStarted",
  "preflightCompleted",
  "prepareStarted",
  "prepareCompleted",
  "attachmentResolveStarted",
  "attachmentResolveCompleted",
  "terminalPlaced",
  "panePublished",
  "attemptCompleted",
  "hostedLaunchCompleted",
  "quickResultReceived",
  "overlayCloseRequested",
  "canonicalWaitStarted",
  "canonicalWaitCompleted",
] as const;

export type ManagedLaunchDiagnosticPhase = (typeof managedLaunchDiagnosticPhases)[number];

type ManagedLaunchDiagnosticEvent = {
  phase: ManagedLaunchDiagnosticPhase;
  atMs: number;
};

const enabled =
  process.env.STATION_QUICK_SESSION_MANAGED_LAUNCH_PHASE_DIAGNOSTIC === "1";
const events: ManagedLaunchDiagnosticEvent[] = [];

if (enabled) {
  process.once("exit", () => {
    writeSync(
      2,
      `${MANAGED_LAUNCH_PHASE_DIAGNOSTIC_PREFIX}${JSON.stringify({ events })}\n`,
    );
  });
}

/**
 * Records an in-memory Quick Session phase without performing diagnostic I/O;
 * the complete trace is emitted synchronously only as the UI process exits.
 */
export function markManagedLaunchDiagnosticPhase(phase: ManagedLaunchDiagnosticPhase): void {
  if (enabled) {
    events.push({ phase, atMs: performance.now() });
  }
}
