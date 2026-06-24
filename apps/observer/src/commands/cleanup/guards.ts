import { normalize } from "node:path";
import type { ProjectView, SafeError, SessionView, WorktreeRow } from "@station/contracts";
import { isRunningAgentState } from "@station/contracts";

export function assertWorktreeRemovalAllowed(
  row: WorktreeRow,
  force: boolean,
  project?: ProjectView | undefined,
): void {
  if (project !== undefined && samePath(row.path, project.root)) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED",
      message: "The project root checkout cannot be removed as a worktree.",
      hint: "Close the session without removing the checkout, or choose a managed worktree.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
    throw error;
  }

  if (row.worktree.dirty === true && !force) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_DIRTY_REQUIRES_FORCE",
      message: "This worktree has uncommitted changes and cannot be removed without force.",
      hint: "Review the worktree changes, or confirm the removal with force.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    throw error;
  }

  if (isRunningAgentState(row.agent?.state) && !force) {
    const error: SafeError = {
      tag: "CommandValidationError",
      code: "WORKTREE_AGENT_ACTIVE_REQUIRES_FORCE",
      message: "This worktree has an active agent and cannot be removed without force.",
      hint: "Close the agent first, or confirm the removal with force.",
      projectId: row.projectId,
      worktreeId: row.id,
    };
    if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
    throw error;
  }
}

export function assertSessionCloseAllowed(
  session: SessionView,
  row: WorktreeRow | undefined,
  force: boolean,
): void {
  if (!isSessionOrRowRunning(session, row) || force) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "SESSION_AGENT_ACTIVE_REQUIRES_FORCE",
    message: "This session has an active agent and cannot be closed without force.",
    hint: "Confirm the close operation with force to stop the active agent.",
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    sessionId: session.id,
  };
  throw error;
}

export function assertTerminalCloseAllowed(
  row: WorktreeRow | undefined,
  session: SessionView | undefined,
  force: boolean,
): void {
  if (!isSessionOrRowRunning(session, row) || force) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "TERMINAL_CLOSE_AGENT_ACTIVE_REQUIRES_FORCE",
    message: "This terminal hosts an active agent and cannot be closed without force.",
    hint: "Confirm the close operation with force to stop or detach the active target.",
  };
  if (session?.projectId !== undefined) error.projectId = session.projectId;
  if (row?.projectId !== undefined) error.projectId = row.projectId;
  if (session?.worktreeId !== undefined) error.worktreeId = session.worktreeId;
  if (row?.id !== undefined) error.worktreeId = row.id;
  if (session?.id !== undefined) error.sessionId = session.id;
  if (row?.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
  throw error;
}

function isSessionOrRowRunning(
  session: SessionView | undefined,
  row: WorktreeRow | undefined,
): boolean {
  return isRunningAgentState(row?.agent?.state ?? session?.status.value);
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}
