import type { WorktreeObservation } from "@station/contracts";
import { staleChangeSummary, staleChecks, stalePullRequest } from "../metadata/stalePayloads.js";
import type { WorktreeMetadataStore } from "../persistence/index.js";

/**
 * Hydrates provider worktrees from the cache while retaining the existing stale-payload projection.
 */
export async function worktreesWithCachedMetadata(input: {
  persistence?: WorktreeMetadataStore;
  worktrees: WorktreeObservation[];
  now: string;
}): Promise<WorktreeObservation[]> {
  if (input.persistence === undefined || input.worktrees.length === 0) {
    return input.worktrees;
  }

  const [changeRows, pullRequestRows, checksRows] = await Promise.all([
    input.persistence.listWorktreeMetadataCurrent({
      kind: "change_summary",
      includeExpired: true,
      now: input.now,
    }),
    input.persistence.listWorktreeMetadataCurrent({
      kind: "pull_request",
      includeExpired: true,
      now: input.now,
    }),
    input.persistence.listWorktreeMetadataCurrent({
      kind: "checks",
      includeExpired: true,
      now: input.now,
    }),
  ]);
  if (changeRows.length === 0 && pullRequestRows.length === 0 && checksRows.length === 0) {
    return input.worktrees;
  }

  const changeByWorktree = new Map(changeRows.map((row) => [row.worktreeId, row]));
  const pullRequestByWorktree = new Map(pullRequestRows.map((row) => [row.worktreeId, row]));
  const checksByWorktree = new Map(checksRows.map((row) => [row.worktreeId, row]));

  return input.worktrees.map((worktree) => {
    const change = changeByWorktree.get(worktree.id);
    const pullRequest = pullRequestByWorktree.get(worktree.id);
    const checks = checksByWorktree.get(worktree.id);
    if (change === undefined && pullRequest === undefined && checks === undefined) {
      return worktree;
    }

    const enriched: WorktreeObservation = { ...worktree };
    if (change !== undefined) {
      enriched.changeSummary =
        change.expired || change.stale ? staleChangeSummary(change.payload) : change.payload;
    }
    if (pullRequest !== undefined) {
      enriched.pr =
        pullRequest.expired || pullRequest.stale
          ? stalePullRequest(pullRequest.payload)
          : pullRequest.payload;
    }
    if (checks !== undefined) {
      enriched.checks =
        checks.expired || checks.stale ? staleChecks(checks.payload) : checks.payload;
    }
    return enriched;
  });
}
