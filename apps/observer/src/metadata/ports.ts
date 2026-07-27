import type { WorktreeChangeSummary } from "@station/contracts";

export type WorktreeMetadataTarget = {
  worktreeId: string;
  projectId: string;
  branch: string;
  registrationIdentity?: string;
};

export type WorktreeChangeBaseSelection = {
  observedPullRequestBase?: string;
  cachedPullRequestBase?: string;
  defaultBranch?: string;
  worktrunkBase?: string;
};

export type WorktreeChangeReadRequest = {
  target: WorktreeMetadataTarget;
  baseSelection: WorktreeChangeBaseSelection;
  signal: AbortSignal;
};

export type WorktreeChangeEvidence = {
  summary: WorktreeChangeSummary;
  cacheKey: string;
};

export type WorktreeChangeReadResult =
  | { status: "available"; evidence: WorktreeChangeEvidence }
  | { status: "unavailable" }
  | { status: "superseded" };

/**
 * DRIVEN PORT
 *
 * Supplies typed checkout-local change evidence for an expected Station worktree
 * while keeping paths and Git execution outside the use case.
 *
 * Local Git is authoritative only for checkout `HEAD`, refs, merge-base, and
 * numstat at read time. Reads honor cancellation, and a Station identity that
 * no longer resolves is reported as superseded rather than as absent evidence.
 */
export interface WorktreeChangeSource {
  read(request: WorktreeChangeReadRequest): Promise<WorktreeChangeReadResult>;
}

/**
 * DRIVEN PORT
 *
 * Maintains the complete set of worktrees whose local metadata may be invalidated
 * and terminates all associated callbacks.
 *
 * Notifications are reconcile hints only. Replacement is full-set, and
 * shutdown is idempotent and terminal.
 */
export interface WorktreeMetadataInvalidationSource {
  replaceWatchedWorktrees(targets: readonly WorktreeMetadataTarget[]): Promise<void>;
  shutdown(): Promise<void>;
}
