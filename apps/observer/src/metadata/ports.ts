import type {
  ProviderProjectConfig,
  WorktreeChangeSummary,
  WorktreePullRequest,
} from "@station/contracts";

export type WorktreeChangeReadInput = {
  project: ProviderProjectConfig;
  worktree: {
    id: string;
    projectId: string;
    path: string;
    branch: string;
    pullRequest?: WorktreePullRequest;
  };
  cachedPullRequest?: WorktreePullRequest;
  signal: AbortSignal;
};

export type WorktreeChangeEvidence = {
  summary: WorktreeChangeSummary;
  cacheKey: string;
};

/**
 * DRIVEN PORT
 *
 * Reads typed branch-diff evidence for a worktree without exposing Git command execution.
 */
export interface WorktreeChangeSource {
  read(input: WorktreeChangeReadInput): Promise<WorktreeChangeEvidence | undefined>;
}

export type WorktreeMetadataWatchTarget = {
  worktreeId: string;
  path: string;
  branch: string;
};

/**
 * DRIVEN PORT
 *
 * Tracks worktrees whose local metadata must be invalidated without exposing filesystem watcher mechanics.
 */
export interface WorktreeMetadataInvalidationSource {
  replaceWatchedWorktrees(targets: readonly WorktreeMetadataWatchTarget[]): void;
  shutdown(): void;
}
