import type {
  AgentState,
  HarnessEventObservation,
  HarnessEventReport,
  HarnessRunObservation,
  ObservedStatus,
} from "@station/contracts";
import type {
  PersistedSessionHarnessExecution,
  SessionHarnessExecutionEvidence,
} from "./persistence/types.js";

type HarnessExecutionCorrelatedBy = "harnessRunId" | "nativeSessionId" | "sessionId" | "worktreeId";

type HarnessExecutionEvidence = {
  provider: string;
  harnessRunId?: string | undefined;
  sessionId?: string | undefined;
  worktreeId?: string | undefined;
  terminalTargetId?: string | undefined;
  nativeSessionId?: string | undefined;
  status?: ObservedStatus | undefined;
};

type HarnessExecutionMatch = {
  run: HarnessRunObservation;
  correlatedBy: HarnessExecutionCorrelatedBy;
};

const ACTIVE_EXECUTION_STATES = new Set<AgentState>(["starting", "working", "needs_attention"]);
const REPLACEABLE_EXECUTION_STATES = new Set<AgentState>(["idle", "exited"]);

export type SessionHarnessExecutionDecision = {
  mayDeriveState: boolean;
  binding?: PersistedSessionHarnessExecution;
};

/**
 * POLICY
 *
 * Correlates harness evidence to one run while preventing weaker Station labels from crossing native executions.
 */
export function correlateHarnessExecution(input: {
  evidence: HarnessExecutionEvidence;
  runs: readonly HarnessRunObservation[];
  allowNativeBinding?: boolean;
}): HarnessExecutionMatch | undefined {
  const providerRuns = input.runs.filter((run) => run.provider === input.evidence.provider);
  const harnessRunId = input.evidence.harnessRunId;
  if (harnessRunId !== undefined) {
    return singleExecutionMatch(
      providerRuns.filter((run) => run.id === harnessRunId),
      "harnessRunId",
      input.evidence,
      input.allowNativeBinding ?? true,
    );
  }

  const nativeSessionId = input.evidence.nativeSessionId;
  if (nativeSessionId !== undefined) {
    const nativeMatches = providerRuns.filter((run) => run.nativeSessionId === nativeSessionId);
    if (nativeMatches.length > 0) {
      return singleExecutionMatch(
        nativeMatches,
        "nativeSessionId",
        input.evidence,
        input.allowNativeBinding ?? true,
      );
    }
    // Worktree-only evidence describes an external provider session. It may
    // match only the external run synthesized for that exact native identity.
    if (!hasStationExecutionIdentity(input.evidence)) return undefined;
  }

  const sessionId = input.evidence.sessionId;
  if (sessionId !== undefined) {
    return singleExecutionMatch(
      providerRuns.filter((run) => run.sessionId === sessionId),
      "sessionId",
      input.evidence,
      input.allowNativeBinding ?? true,
    );
  }

  if (input.evidence.terminalTargetId !== undefined) return undefined;

  const worktreeId = input.evidence.worktreeId;
  if (worktreeId !== undefined) {
    return singleExecutionMatch(
      providerRuns.filter((run) => run.worktreeId === worktreeId),
      "worktreeId",
      input.evidence,
      input.allowNativeBinding ?? true,
    );
  }

  return undefined;
}

export function sessionHarnessExecutionEvidenceFromReport(
  report: HarnessEventReport,
): SessionHarnessExecutionEvidence {
  const evidence: SessionHarnessExecutionEvidence = {
    provider: report.provider,
  };
  if (report.correlation?.sessionId !== undefined) {
    evidence.sessionId = report.correlation.sessionId;
  }
  if (report.correlation?.nativeSessionId !== undefined) {
    evidence.nativeSessionId = report.correlation.nativeSessionId;
  }
  if (report.status !== undefined) evidence.status = report.status;
  return evidence;
}

export function sessionHarnessExecutionEvidenceFromObservation(
  observation: HarnessEventObservation,
): SessionHarnessExecutionEvidence {
  const evidence: SessionHarnessExecutionEvidence = {
    provider: observation.provider,
  };
  if (observation.sessionId !== undefined) evidence.sessionId = observation.sessionId;
  if (observation.nativeSessionId !== undefined) {
    evidence.nativeSessionId = observation.nativeSessionId;
  }
  if (observation.status !== undefined) evidence.status = observation.status;
  return evidence;
}

/**
 * POLICY
 *
 * Advances one Station session's provider-native execution binding from non-stale evidence.
 */
export function decideSessionHarnessExecution(input: {
  current: PersistedSessionHarnessExecution | undefined;
  evidence: SessionHarnessExecutionEvidence;
}): SessionHarnessExecutionDecision {
  const sessionId = input.evidence.sessionId;
  if (sessionId === undefined) return { mayDeriveState: true };

  const nativeSessionId = input.evidence.nativeSessionId;
  const status = input.evidence.status;
  const current = input.current;
  if (current === undefined) {
    if (
      nativeSessionId === undefined ||
      status === undefined ||
      !ACTIVE_EXECUTION_STATES.has(status.value)
    ) {
      return { mayDeriveState: nativeSessionId === undefined };
    }
    return {
      mayDeriveState: true,
      binding: bindingFromEvidence({
        evidence: input.evidence,
        sessionId,
        nativeSessionId,
        status,
      }),
    };
  }

  if (nativeSessionId === undefined) return { mayDeriveState: false };
  if (current.nativeSessionId !== nativeSessionId) {
    if (
      status === undefined ||
      !ACTIVE_EXECUTION_STATES.has(status.value) ||
      !REPLACEABLE_EXECUTION_STATES.has(current.state) ||
      Date.parse(status.updatedAt) < Date.parse(current.statusUpdatedAt)
    ) {
      return { mayDeriveState: false };
    }
    return {
      mayDeriveState: true,
      binding: bindingFromEvidence({
        evidence: input.evidence,
        sessionId,
        nativeSessionId,
        status,
      }),
    };
  }

  if (
    status !== undefined &&
    status.value !== "unknown" &&
    Date.parse(status.updatedAt) < Date.parse(current.statusUpdatedAt)
  ) {
    return { mayDeriveState: false };
  }

  if (status === undefined || status.value === "unknown") {
    return { mayDeriveState: true };
  }
  const binding: PersistedSessionHarnessExecution = { ...current };
  binding.state = status.value;
  binding.statusUpdatedAt = status.updatedAt;
  return { mayDeriveState: true, binding };
}

/**
 * POLICY
 *
 * Applies durable native identity only to the matching provider-owned Station session run.
 */
export function bindHarnessRunsToSessionExecutions(input: {
  runs: readonly HarnessRunObservation[];
  bindings: readonly PersistedSessionHarnessExecution[];
}): HarnessRunObservation[] {
  const bindings = new Map(
    input.bindings.map((binding) => [
      sessionHarnessExecutionKey(binding.provider, binding.sessionId),
      binding,
    ]),
  );
  return input.runs.map((run) => {
    if (run.sessionId === undefined) return run;
    const binding = bindings.get(sessionHarnessExecutionKey(run.provider, run.sessionId));
    if (binding === undefined || run.nativeSessionId === binding.nativeSessionId) return run;
    return { ...run, nativeSessionId: binding.nativeSessionId };
  });
}

function singleExecutionMatch(
  matches: readonly HarnessRunObservation[],
  correlatedBy: HarnessExecutionCorrelatedBy,
  evidence: HarnessExecutionEvidence,
  allowNativeBinding: boolean,
): HarnessExecutionMatch | undefined {
  const run = matches[0];
  if (matches.length !== 1 || run === undefined) return undefined;

  const decision = nativeExecutionDecision({
    currentNativeSessionId: run.nativeSessionId,
    evidenceNativeSessionId: evidence.nativeSessionId,
    evidenceStatus: evidence.status,
  });
  if (decision === "reject") return undefined;
  if (decision === "bind" && evidence.nativeSessionId !== undefined && allowNativeBinding) {
    return {
      run: { ...run, nativeSessionId: evidence.nativeSessionId },
      correlatedBy,
    };
  }
  if (decision === "bind") return undefined;
  return { run, correlatedBy };
}

function nativeExecutionDecision(input: {
  currentNativeSessionId: string | undefined;
  evidenceNativeSessionId: string | undefined;
  evidenceStatus: ObservedStatus | undefined;
}): "accept" | "bind" | "reject" {
  if (input.currentNativeSessionId === input.evidenceNativeSessionId) {
    return "accept";
  }
  if (
    input.evidenceNativeSessionId !== undefined &&
    input.evidenceStatus !== undefined &&
    ACTIVE_EXECUTION_STATES.has(input.evidenceStatus.value) &&
    input.currentNativeSessionId === undefined
  ) {
    return "bind";
  }
  return "reject";
}

function hasStationExecutionIdentity(
  event: Pick<HarnessExecutionEvidence, "harnessRunId" | "sessionId" | "terminalTargetId">,
): boolean {
  return (
    event.harnessRunId !== undefined ||
    event.sessionId !== undefined ||
    event.terminalTargetId !== undefined
  );
}

function bindingFromEvidence(input: {
  evidence: SessionHarnessExecutionEvidence;
  sessionId: string;
  nativeSessionId: string;
  status: ObservedStatus;
}): PersistedSessionHarnessExecution {
  return {
    provider: input.evidence.provider,
    sessionId: input.sessionId,
    nativeSessionId: input.nativeSessionId,
    state: input.status.value,
    statusUpdatedAt: input.status.updatedAt,
  };
}

function sessionHarnessExecutionKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}
