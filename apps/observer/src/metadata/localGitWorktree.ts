import type { WorktreeMetadataTarget } from "./ports.js";

export type LocalGitMetadataWorktree = WorktreeMetadataTarget & {
  path: string;
};

type LocalGitMetadataWorktreeResolution =
  | { status: "resolved"; worktree: LocalGitMetadataWorktree }
  | { status: "unavailable" }
  | { status: "superseded" };

export type ResolveLocalGitMetadataWorktree = (
  target: WorktreeMetadataTarget,
) => LocalGitMetadataWorktreeResolution;

export function matchesExpectedLocalGitMetadataTarget(
  worktree: LocalGitMetadataWorktree,
  target: WorktreeMetadataTarget,
): boolean {
  return (
    worktree.worktreeId === target.worktreeId &&
    worktree.projectId === target.projectId &&
    worktree.branch === target.branch &&
    worktree.registrationIdentity === target.registrationIdentity
  );
}
