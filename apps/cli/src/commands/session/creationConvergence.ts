import type {
  ProviderId,
  SafeError,
  SessionCreateCommandResult,
  SessionForkCommandResult,
  SessionGroupId,
  StationSnapshot,
} from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import type { SessionProjectionState } from "./convergence.js";
import { findOptionalSessionSummary, type SessionSummary } from "./summary.js";

export type SessionCreationGroupExpectation =
  | { kind: "ungrouped" }
  | { kind: "existing"; groupId: SessionGroupId }
  | { kind: "create"; name: string }
  | { kind: "source"; groupId: SessionGroupId };

export type SessionCreationConvergenceExpectation = {
  action: "create" | "fork";
  branch: string;
  group: SessionCreationGroupExpectation;
  harnessProvider: ProviderId;
  result: SessionCreateCommandResult | SessionForkCommandResult;
  terminalProvider: ProviderId;
  title: string;
};

export type SessionCreationConvergence = {
  status: "confirmed" | "warning";
  session: SessionProjectionState;
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
        { state: "present", value: session },
        `SESSION_${expectation.action.toUpperCase()}_CONVERGENCE_STALE`,
        `The session ${expectation.action} command succeeded, but the refreshed snapshot does not preserve the expected identity and relationships.`,
      );
    }
    return {
      status: "confirmed",
      session: { state: "present", value: session },
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
  const assigned = snapshot.sessionGroups.find((group) =>
    group.sessionIds.includes(expectation.result.sessionId),
  );
  switch (expectation.group.kind) {
    case "ungrouped":
      return assigned === undefined;
    case "existing":
      return assigned?.id === expectation.group.groupId;
    case "create":
      return assigned?.name === expectation.group.name && assigned.parentGroupId === undefined;
    case "source": {
      if (assigned?.id === expectation.group.groupId) return true;
      const sourceGroupId = expectation.group.groupId;
      const sourceGroupStillExists = snapshot.sessionGroups.some(
        (group) => group.id === sourceGroupId,
      );
      return assigned === undefined && !sourceGroupStillExists;
    }
  }
}

function warningConvergence(
  expectation: SessionCreationConvergenceExpectation,
  session: SessionProjectionState,
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
