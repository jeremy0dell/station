import type { WorktreeMetadataTarget } from "./ports.js";

export type LocalGitMetadataWorktree = WorktreeMetadataTarget & {
  path: string;
};

export type ResolveLocalGitMetadataWorktree = (
  target: WorktreeMetadataTarget,
) => LocalGitMetadataWorktree | undefined;
