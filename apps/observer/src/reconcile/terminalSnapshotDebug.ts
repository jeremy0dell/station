import type {
  ProviderHealth,
  SnapshotTerminalDebug,
  SnapshotTerminalProviderRead,
  SnapshotTerminalTargetDebug,
  TerminalTargetObservation,
} from "@station/contracts";
import type { TerminalProviderReadOutcome } from "./providerObservations.js";
import { terminalControlEvidence } from "./terminalControlEvidence.js";

/** Builds one sanitized, point-in-time terminal evidence envelope from a completed reconcile. */
export function buildTerminalSnapshotDebug(input: {
  reconciledAt: string;
  targets: readonly TerminalTargetObservation[];
  providerReads: readonly TerminalProviderReadOutcome[];
  providerHealth: Readonly<Record<string, ProviderHealth>>;
}): SnapshotTerminalDebug {
  const completeProviders = new Set(
    input.providerReads.filter((read) => read.status === "complete").map((read) => read.providerId),
  );
  return {
    reconciledAt: input.reconciledAt,
    providerReads: input.providerReads.map(snapshotProviderRead),
    targets: input.targets
      .filter((target) => completeProviders.has(target.provider))
      .map((target) => snapshotTerminalTarget(target, input.providerHealth[target.provider])),
  };
}

function snapshotProviderRead(read: TerminalProviderReadOutcome): SnapshotTerminalProviderRead {
  if (read.status === "complete") {
    return { provider: read.providerId, status: "complete" };
  }
  return {
    provider: read.providerId,
    status: "indeterminate",
    failureCode: read.failureCode,
  };
}

function snapshotTerminalTarget(
  target: TerminalTargetObservation,
  health: ProviderHealth | undefined,
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
  const control = terminalControlEvidence(target, health?.capabilities);
  if (control.focusable !== undefined) debug.focusable = control.focusable;
  if (control.closeable !== undefined) debug.closeable = control.closeable;
  if (target.hasManagedAttachment !== undefined) {
    debug.hasManagedAttachment = target.hasManagedAttachment;
  }
  return debug;
}
