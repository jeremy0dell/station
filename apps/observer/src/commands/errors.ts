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
