import type {
  HarnessEventObservation,
  HarnessEventReport,
  SessionRecoveryHandle,
} from "@station/contracts";

type HarnessRecoveryEvidence = {
  id: string;
  provider: SessionRecoveryHandle["provider"];
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  nativeSessionId?: string;
  nativeSessionFile?: string;
  cwd?: string;
  terminalTargetId?: string;
  harnessRunId?: string;
  observedAt: string;
};

/** Builds recovery evidence from a normalized live report without inspecting provider data. */
export function sessionRecoveryHandleFromReport(
  report: HarnessEventReport,
): SessionRecoveryHandle | undefined {
  const evidence: HarnessRecoveryEvidence = {
    id: report.reportId,
    provider: report.provider,
    observedAt: report.observedAt,
  };
  const correlation = report.correlation;
  if (correlation?.projectId !== undefined) evidence.projectId = correlation.projectId;
  if (correlation?.worktreeId !== undefined) evidence.worktreeId = correlation.worktreeId;
  if (correlation?.sessionId !== undefined) evidence.sessionId = correlation.sessionId;
  if (correlation?.nativeSessionId !== undefined) {
    evidence.nativeSessionId = correlation.nativeSessionId;
  }
  if (correlation?.nativeSessionFile !== undefined) {
    evidence.nativeSessionFile = correlation.nativeSessionFile;
  }
  if (correlation?.cwd !== undefined) evidence.cwd = correlation.cwd;
  if (correlation?.terminalTargetId !== undefined) {
    evidence.terminalTargetId = correlation.terminalTargetId;
  }
  if (correlation?.harnessRunId !== undefined) {
    evidence.harnessRunId = correlation.harnessRunId;
  }
  return sessionRecoveryHandleFromEvidence(evidence);
}

/** Rebuilds recovery evidence from an admitted observation during durable-state repair. */
export function sessionRecoveryHandleFromObservation(
  observation: HarnessEventObservation,
  fallbackId: string,
): SessionRecoveryHandle | undefined {
  const evidence: HarnessRecoveryEvidence = {
    id: observation.reportId ?? fallbackId,
    provider: observation.provider,
    observedAt: observation.observedAt,
  };
  if (observation.projectId !== undefined) evidence.projectId = observation.projectId;
  if (observation.worktreeId !== undefined) evidence.worktreeId = observation.worktreeId;
  if (observation.sessionId !== undefined) evidence.sessionId = observation.sessionId;
  if (observation.nativeSessionId !== undefined) {
    evidence.nativeSessionId = observation.nativeSessionId;
  }
  if (observation.nativeSessionFile !== undefined) {
    evidence.nativeSessionFile = observation.nativeSessionFile;
  }
  if (observation.cwd !== undefined) evidence.cwd = observation.cwd;
  if (observation.terminalTargetId !== undefined) {
    evidence.terminalTargetId = observation.terminalTargetId;
  }
  if (observation.harnessRunId !== undefined) {
    evidence.harnessRunId = observation.harnessRunId;
  }
  return sessionRecoveryHandleFromEvidence(evidence);
}

function sessionRecoveryHandleFromEvidence(
  evidence: HarnessRecoveryEvidence,
): SessionRecoveryHandle | undefined {
  if (
    evidence.projectId === undefined ||
    evidence.worktreeId === undefined ||
    (evidence.nativeSessionId === undefined && evidence.nativeSessionFile === undefined)
  ) {
    return undefined;
  }

  // Pane-scoped native identity is the Station run id, not a provider resume target.
  if (
    evidence.nativeSessionFile === undefined &&
    evidence.nativeSessionId !== undefined &&
    evidence.harnessRunId !== undefined &&
    evidence.nativeSessionId === evidence.harnessRunId
  ) {
    return undefined;
  }

  const target =
    evidence.nativeSessionFile !== undefined
      ? ({ kind: "session-file", path: evidence.nativeSessionFile } as const)
      : nativeSessionTarget(evidence.nativeSessionId);
  const handle: SessionRecoveryHandle = {
    id: evidence.id,
    provider: evidence.provider,
    projectId: evidence.projectId,
    worktreeId: evidence.worktreeId,
    target,
    observedAt: evidence.observedAt,
    lastSeenAt: evidence.observedAt,
  };
  if (evidence.sessionId !== undefined) handle.sessionId = evidence.sessionId;
  if (evidence.cwd !== undefined) handle.cwd = evidence.cwd;
  if (evidence.terminalTargetId !== undefined) {
    handle.terminalTargetId = evidence.terminalTargetId;
  }
  if (evidence.harnessRunId !== undefined) handle.harnessRunId = evidence.harnessRunId;
  return handle;
}

function nativeSessionTarget(id: string | undefined): { kind: "native-session"; id: string } {
  if (id === undefined) {
    throw new Error("Expected a native session id after recovery correlation validation.");
  }
  return { kind: "native-session", id };
}
