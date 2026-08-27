import type {
  ProviderId,
  SafeError,
  SessionCreateCommandResult,
  SessionForkCommandResult,
  StationSnapshot,
} from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import { findOptionalSessionSummary, type SessionSummary } from "./summary.js";

export type SessionCreationConvergenceExpectation = {
  action: "create" | "fork";
  branch: string;
  harnessProvider: ProviderId;
  result: SessionCreateCommandResult | SessionForkCommandResult;
  terminalProvider: ProviderId;
  title: string;
};

export type SessionCreationProjectionState =
  | { state: "present" }
  | { state: "missing" }
  | { state: "unknown" };

export type SessionCreationConvergence = {
  status: "confirmed" | "warning";
  session: SessionCreationProjectionState;
  warning?: SafeError;
};

export async function loadSessionCreationConvergence(
  expectation: SessionCreationConvergenceExpectation,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<SessionCreationConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const session = findOptionalSessionSummary(snapshot, expectation.result.sessionId);
    if (session === undefined) {
      return warningConvergence(
        expectation,
        { state: "missing" },
        `SESSION_${expectation.action.toUpperCase()}_CONVERGENCE_MISSING`,
        `The session ${expectation.action} command succeeded, but the refreshed snapshot does not contain the created session.`,
      );
    }
    if (!sessionIdentityConverged(session, expectation) || !groupConverged(snapshot, expectation)) {
      return warningConvergence(
        expectation,
        { state: "present" },
        `SESSION_${expectation.action.toUpperCase()}_CONVERGENCE_STALE`,
        `The session ${expectation.action} command succeeded, but the refreshed snapshot does not preserve the expected identity and relationships.`,
      );
    }
    return {
      status: "confirmed",
      session: { state: "present" },
    };
  } catch (error) {
    const warning = publicSafeErrorFromUnknown(error, {
      tag: "SessionCliError",
      code: `SESSION_${expectation.action.toUpperCase()}_CONVERGENCE_REFRESH_FAILED`,
      message: `The session ${expectation.action} command succeeded, but Station could not load the refreshed snapshot.`,
    });
    attachResultIdentity(warning, expectation.result);
    return {
      status: "warning",
      session: { state: "unknown" },
      warning,
    };
  }
}

function sessionIdentityConverged(
  session: SessionSummary,
  expectation: SessionCreationConvergenceExpectation,
): boolean {
  return (
    session.sessionId === expectation.result.sessionId &&
    session.projectId === expectation.result.projectId &&
    session.worktreeId === expectation.result.worktreeId &&
    session.branch === expectation.branch &&
    session.title === expectation.title &&
    session.worktreeTitle === expectation.title &&
    session.harness.provider === expectation.harnessProvider &&
    session.terminal?.provider === expectation.terminalProvider
  );
}

function groupConverged(
  snapshot: StationSnapshot,
  expectation: SessionCreationConvergenceExpectation,
): boolean {
  const assignedGroups = snapshot.sessionGroups.filter((group) =>
    group.sessionIds.includes(expectation.result.sessionId),
  );
  if (expectation.result.resolvedGroupId === undefined) return assignedGroups.length === 0;
  if (assignedGroups.length !== 1 || assignedGroups[0]?.id !== expectation.result.resolvedGroupId) {
    return false;
  }
  return expectation.action === "fork" || assignedGroups[0].parentGroupId === undefined;
}

function warningConvergence(
  expectation: SessionCreationConvergenceExpectation,
  session: SessionCreationProjectionState,
  code: string,
  message: string,
): SessionCreationConvergence {
  const warning: SafeError = {
    tag: "SessionCliError",
    code,
    message,
    hint: "Inspect `stn session get <sessionId> --json` or `stn snapshot --json` before another mutation.",
  };
  attachResultIdentity(warning, expectation.result);
  return { status: "warning", session, warning };
}

function attachResultIdentity(
  error: SafeError,
  result: SessionCreateCommandResult | SessionForkCommandResult,
): void {
  error.sessionId ??= result.sessionId;
  error.projectId ??= result.projectId;
  error.worktreeId ??= result.worktreeId;
}
