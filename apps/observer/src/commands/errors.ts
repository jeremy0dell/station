import type { SafeError } from "@station/contracts";

export function worktreeMissingError(input: {
  worktreeId: string;
  projectId?: string | undefined;
  message: string;
  hint?: string | undefined;
}): SafeError {
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "WORKTREE_NOT_FOUND",
    message: input.message,
    worktreeId: input.worktreeId,
  };
  if (input.projectId !== undefined) error.projectId = input.projectId;
  if (input.hint !== undefined) error.hint = input.hint;
  return error;
}

export function sessionGroupMissingError(groupId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_NOT_FOUND",
    message: `No durable Session Group matches ${groupId}.`,
    hint: "Refresh the canonical Group state and retry with a current Group id.",
    projectId,
  };
}

export function sessionGroupProjectMismatchError(groupId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_PROJECT_MISMATCH",
    message: `Session Group ${groupId} does not belong to the requested project.`,
    hint: "Use only Groups from the session's configured project.",
    projectId,
  };
}

export function sessionGroupNotRootError(groupId: string, projectId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_NOT_ROOT",
    message: `Session Group ${groupId} is nested and cannot receive a new session.`,
    hint: "Choose a root Group from the session's configured project.",
    projectId,
  };
}

export function sessionGroupIdCollisionError(projectId: string): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_ID_COLLISION",
    message: "The Observer generated a Session Group id that already exists.",
    hint: "Retry the command to generate a new Group id.",
    projectId,
  };
}

export function sessionGroupMembershipAssignmentConflictError(projectId: string): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
    message: "A session's current Group assignment did not match the command expectation.",
    hint: "Refresh the canonical Group state before retrying the membership change.",
    projectId,
  };
}

export function sessionGroupPlacementAssignmentConflictError(projectId: string): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
    message: "A session's current Group assignment did not match the requested placement.",
    hint: "Refresh the canonical Group state before retrying the session operation.",
    projectId,
  };
}
