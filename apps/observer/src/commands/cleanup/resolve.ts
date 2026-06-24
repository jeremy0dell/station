import type { SafeError, SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";
import { worktreeMissingError } from "../errors.js";

export function resolveSessionOrThrow(snapshot: StationSnapshot, sessionId: string): SessionView {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session !== undefined) {
    return session;
  }
  throw sessionMissingError(sessionId);
}

export function resolveWorktreeRowOrThrow(
  snapshot: StationSnapshot,
  worktreeId: string,
  projectId?: string,
): WorktreeRow {
  const row = snapshot.rows.find((candidate) => candidate.id === worktreeId);
  if (row === undefined) {
    throw snapshotWorktreeMissingError(worktreeId, projectId);
  }
  if (projectId !== undefined && row.projectId !== projectId) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_PROJECT_MISMATCH",
      message: "The requested worktree belongs to a different configured project.",
      projectId,
      worktreeId,
    };
    throw error;
  }
  return row;
}

export function resolveRowForSession(
  snapshot: StationSnapshot,
  session: SessionView,
): WorktreeRow | undefined {
  return snapshot.rows.find((candidate) => candidate.id === session.worktreeId);
}

export function sessionMissingError(sessionId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_NOT_FOUND",
    message: "The requested session is not visible in the observer snapshot.",
    hint: "Refresh the dashboard and retry.",
    sessionId,
  };
}

export function snapshotWorktreeMissingError(worktreeId: string, projectId?: string): SafeError {
  return worktreeMissingError({
    worktreeId,
    projectId,
    message: "The requested worktree is not visible in the observer snapshot.",
    hint: "Refresh the dashboard and retry.",
  });
}
