import type { SnapshotTerminalTargetDebug, TerminalTargetObservation } from "@station/contracts";

/** Builds the redaction-safe target evidence exposed only by opt-in debug snapshots. */
export function terminalTargetDebugFromObservation(
  target: TerminalTargetObservation,
): SnapshotTerminalTargetDebug {
  const debug: SnapshotTerminalTargetDebug = {
    id: target.id,
    provider: target.provider,
    state: target.state,
    confidence: target.confidence,
    reason: target.reason,
    observedAt: target.observedAt,
  };
  if (target.projectId !== undefined) debug.projectId = target.projectId;
  if (target.worktreeId !== undefined) debug.worktreeId = target.worktreeId;
  if (target.sessionId !== undefined) debug.sessionId = target.sessionId;
  if (target.focusable !== undefined) debug.focusable = target.focusable;
  if (target.closeable !== undefined) debug.closeable = target.closeable;
  if (target.hasManagedAttachment !== undefined) {
    debug.hasManagedAttachment = target.hasManagedAttachment;
  }
  return debug;
}

export function terminalTargetDebugFromObservations(
  targets: readonly TerminalTargetObservation[],
): SnapshotTerminalTargetDebug[] {
  return targets.map(terminalTargetDebugFromObservation);
}
