import type { SafeError } from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type { ObserverProcessDeps } from "../../observerProcess.js";
import { loadObserverSnapshot, type ObserverSnapshotLoadOptions } from "../snapshot.js";
import {
  findOptionalSessionSummary,
  findSessionWorktreeSummary,
  type SessionSummary,
  type SessionWorktreeSummary,
} from "./summary.js";

export type SessionProjectionState =
  | { state: "present"; value: SessionSummary }
  | { state: "missing" }
  | { state: "unknown" };

export type SessionWorktreeProjectionState =
  | { state: "present"; value: SessionWorktreeSummary }
  | { state: "missing" }
  | { state: "unknown" };

export type RenameSessionConvergence = {
  status: "confirmed" | "warning";
  session: SessionProjectionState;
  warning?: SafeError;
};

export type CloseSessionConvergence = {
  status: "confirmed" | "warning";
  session: SessionProjectionState;
  worktree: SessionWorktreeProjectionState;
  warning?: SafeError;
};

export async function loadRenameSessionConvergence(
  target: SessionSummary,
  requestedTitle: string,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<RenameSessionConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const session = findOptionalSessionSummary(snapshot, target.sessionId);
    if (session === undefined) {
      return {
        status: "warning",
        session: { state: "missing" },
        warning: convergenceWarning(
          "SESSION_RENAME_CONVERGENCE_MISSING",
          "The rename command succeeded, but the refreshed snapshot no longer contains the session.",
          target,
        ),
      };
    }
    if (!renameConverged(target, session, requestedTitle)) {
      return {
        status: "warning",
        session: { state: "present", value: session },
        warning: convergenceWarning(
          "SESSION_RENAME_CONVERGENCE_STALE",
          "The rename command succeeded, but the refreshed snapshot did not preserve the expected identity and title.",
          target,
        ),
      };
    }
    return {
      status: "confirmed",
      session: { state: "present", value: session },
    };
  } catch (error) {
    return {
      status: "warning",
      session: { state: "unknown" },
      warning: convergenceRefreshWarning(error, "rename", target),
    };
  }
}

export async function loadCloseSessionConvergence(
  target: SessionSummary,
  options: ObserverSnapshotLoadOptions,
  deps: ObserverProcessDeps,
): Promise<CloseSessionConvergence> {
  try {
    const snapshot = await loadObserverSnapshot(options, deps);
    const worktree = findSessionWorktreeSummary(snapshot, target);
    if (worktree === undefined) {
      return {
        status: "warning",
        session: { state: "unknown" },
        worktree: { state: "missing" },
        warning: convergenceWarning(
          "SESSION_CLOSE_WORKTREE_MISSING",
          "The close command succeeded, but the refreshed snapshot no longer contains its worktree.",
          target,
        ),
      };
    }
    const session = findOptionalSessionSummary(snapshot, target.sessionId);
    const sessionState: SessionProjectionState =
      session === undefined ? { state: "missing" } : { state: "present", value: session };
    if (!worktreeRetained(target, worktree)) {
      return {
        status: "warning",
        session: sessionState,
        worktree: { state: "present", value: worktree },
        warning: convergenceWarning(
          "SESSION_CLOSE_WORKTREE_CHANGED",
          "The close command succeeded, but the refreshed worktree identity changed unexpectedly.",
          target,
        ),
      };
    }
    return {
      status: "confirmed",
      session: sessionState,
      worktree: { state: "present", value: worktree },
    };
  } catch (error) {
    return {
      status: "warning",
      session: { state: "unknown" },
      worktree: { state: "unknown" },
      warning: convergenceRefreshWarning(error, "close", target),
    };
  }
}

function renameConverged(
  target: SessionSummary,
  refreshed: SessionSummary,
  requestedTitle: string,
): boolean {
  return (
    refreshed.sessionId === target.sessionId &&
    refreshed.projectId === target.projectId &&
    refreshed.worktreeId === target.worktreeId &&
    refreshed.title === requestedTitle &&
    refreshed.worktreeTitle === requestedTitle &&
    refreshed.branch === target.branch &&
    refreshed.path === target.path &&
    refreshed.harness.provider === target.harness.provider &&
    refreshed.harness.mode === target.harness.mode &&
    refreshed.harness.runId === target.harness.runId
  );
}

function worktreeRetained(target: SessionSummary, refreshed: SessionWorktreeSummary): boolean {
  return (
    refreshed.projectId === target.projectId &&
    refreshed.worktreeId === target.worktreeId &&
    refreshed.title === target.worktreeTitle &&
    refreshed.branch === target.branch &&
    refreshed.path === target.path
  );
}

function convergenceRefreshWarning(
  error: unknown,
  action: "rename" | "close",
  target: SessionSummary,
): SafeError {
  const normalized = publicSafeErrorFromUnknown(error, {
    tag: "SessionCliError",
    code: `SESSION_${action.toUpperCase()}_CONVERGENCE_REFRESH_FAILED`,
    message: `The ${action} command succeeded, but Station could not load the refreshed snapshot.`,
  });
  const warning: SafeError = { ...normalized };
  if (warning.sessionId === undefined) warning.sessionId = target.sessionId;
  if (warning.projectId === undefined) warning.projectId = target.projectId;
  if (warning.worktreeId === undefined) warning.worktreeId = target.worktreeId;
  return warning;
}

function convergenceWarning(code: string, message: string, target: SessionSummary): SafeError {
  return {
    tag: "SessionCliError",
    code,
    message,
    hint: "Inspect `stn session get <sessionId> --json` or `stn snapshot --json` before another mutation.",
    sessionId: target.sessionId,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  };
}
