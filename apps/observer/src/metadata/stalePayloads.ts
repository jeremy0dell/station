import type {
  WorktreeChangeSummary,
  WorktreeChecksSummary,
  WorktreePullRequest,
} from "@station/contracts";

export function staleChangeSummary(payload: WorktreeChangeSummary): WorktreeChangeSummary {
  const stale: WorktreeChangeSummary = {
    kind: payload.kind,
    additions: payload.additions,
    deletions: payload.deletions,
    source: payload.source,
    checkedAt: payload.checkedAt,
    stale: true,
  };
  if (payload.filesChanged !== undefined) stale.filesChanged = payload.filesChanged;
  if (payload.binaryFiles !== undefined) stale.binaryFiles = payload.binaryFiles;
  if (payload.baseRef !== undefined) stale.baseRef = payload.baseRef;
  if (payload.baseSha !== undefined) stale.baseSha = payload.baseSha;
  if (payload.mergeBaseSha !== undefined) stale.mergeBaseSha = payload.mergeBaseSha;
  if (payload.headRef !== undefined) stale.headRef = payload.headRef;
  if (payload.headSha !== undefined) stale.headSha = payload.headSha;
  return stale;
}

export function stalePullRequest(
  payload: WorktreePullRequest,
): WorktreePullRequest & { stale: true } {
  const stale: WorktreePullRequest & { stale: true } = {
    number: payload.number,
    stale: true,
  };
  if (payload.url !== undefined) stale.url = payload.url;
  if (payload.host !== undefined) stale.host = payload.host;
  if (payload.state !== undefined) stale.state = payload.state;
  if (payload.baseRef !== undefined) stale.baseRef = payload.baseRef;
  if (payload.headRef !== undefined) stale.headRef = payload.headRef;
  if (payload.updatedAt !== undefined) stale.updatedAt = payload.updatedAt;
  if (payload.checkedAt !== undefined) stale.checkedAt = payload.checkedAt;
  return stale;
}

export function staleChecks(
  payload: WorktreeChecksSummary,
): WorktreeChecksSummary & { stale: true } {
  const stale: WorktreeChecksSummary & { stale: true } = {
    state: payload.state,
    source: payload.source,
    checkedAt: payload.checkedAt,
    stale: true,
  };
  if (payload.url !== undefined) stale.url = payload.url;
  if (payload.total !== undefined) stale.total = payload.total;
  if (payload.passed !== undefined) stale.passed = payload.passed;
  if (payload.failed !== undefined) stale.failed = payload.failed;
  if (payload.pending !== undefined) stale.pending = payload.pending;
  if (payload.skipped !== undefined) stale.skipped = payload.skipped;
  if (payload.cancelled !== undefined) stale.cancelled = payload.cancelled;
  if (payload.reason !== undefined) stale.reason = payload.reason;
  return stale;
}
