import type {
  ProviderProjectConfig,
  RepositoryProvider,
  SafeError,
  StationSnapshot,
  WorktreeChecksSummary,
  WorktreePullRequest,
} from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import {
  forEachConcurrent,
  type RuntimeClock,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { toSafeError } from "../diagnostics/errors.js";
import type {
  ObserverPersistence,
  PersistedWorktreeMetadataCurrent,
} from "../persistence/index.js";
import { addMs } from "../utils/time.js";
import {
  type RepositoryGitContext,
  readRepositoryGitContext,
  repositoryMetadataCacheKey,
} from "./repositoryGit.js";
import { selectRepositoryProvider } from "./repositoryProviderSelection.js";
import { staleChecks, stalePullRequest } from "./stalePayloads.js";

/**
 * USE CASE
 *
 * Refreshes and persists code-host metadata for snapshot worktrees through
 * matching repository provider ports.
 */
export type RepositoryMetadataRefresher = {
  refresh(input: RepositoryRefreshInput): Promise<void>;
};

export type RepositoryRefreshInput = {
  snapshot: StationSnapshot;
  pullRequestByWorktree: ReadonlyMap<string, PersistedWorktreeMetadataCurrent<"pull_request">>;
  checksByWorktree: ReadonlyMap<string, PersistedWorktreeMetadataCurrent<"checks">>;
  signal: AbortSignal;
};

export type CreateRepositoryMetadataRefresherOptions = {
  projectsById: ReadonlyMap<string, ProviderProjectConfig>;
  persistence: ObserverPersistence;
  requestReconcile(reason: string): void;
  clock?: RuntimeClock;
  logger?: JsonlLogger;
  repositoryProviders?: Iterable<RepositoryProvider> | Map<string, RepositoryProvider>;
  repositoryConcurrency?: number;
  negativeBackoffMs?: number;
};

type RepositoryRefreshTask = {
  row: StationSnapshot["rows"][number];
  git: RepositoryGitContext;
  provider: RepositoryProvider;
  existingPullRequest?: PersistedWorktreeMetadataCurrent<"pull_request">;
  existingChecks?: PersistedWorktreeMetadataCurrent<"checks">;
};

const defaultTtlMs = 5 * 60 * 1000;
const runningChecksTtlMs = 60 * 1000;
const defaultRepositoryConcurrency = 2;

export function createRepositoryMetadataRefresher(
  options: CreateRepositoryMetadataRefresherOptions,
): RepositoryMetadataRefresher {
  const clock = options.clock ?? systemClock;
  const repositoryProviders = repositoryProviderMap(options.repositoryProviders);
  const negativeBackoff = new Map<string, number>();

  return {
    refresh: async (input) => {
      if (repositoryProviders.size === 0 || input.signal.aborted) {
        return;
      }

      const grouped = collectRepositoryTasks(input);
      for (const tasks of grouped.values()) {
        if (input.signal.aborted) {
          return;
        }
        await forEachConcurrent(
          tasks,
          { concurrency: options.repositoryConcurrency ?? defaultRepositoryConcurrency },
          async (task) => {
            if (!input.signal.aborted) {
              await refreshRepositoryRow(task, input.signal);
            }
          },
        );
      }
    },
  };

  function collectRepositoryTasks(
    input: RepositoryRefreshInput,
  ): Map<string, RepositoryRefreshTask[]> {
    const grouped = new Map<string, RepositoryRefreshTask[]>();
    for (const row of input.snapshot.rows) {
      if (input.signal.aborted || !options.projectsById.has(row.projectId)) {
        continue;
      }

      const git = readRepositoryGitContext({
        worktree: {
          id: row.id,
          projectId: row.projectId,
          path: row.path,
          branch: row.branch,
          state: row.worktree.state,
          ...(row.worktree.remote !== undefined ? { remote: row.worktree.remote } : {}),
          ...(row.worktree.headSha !== undefined ? { headSha: row.worktree.headSha } : {}),
        },
        clock,
      });
      const provider = git === undefined ? undefined : repositoryProviderFor(git);
      if (git === undefined || provider === undefined) {
        continue;
      }

      const task: RepositoryRefreshTask = {
        row,
        git,
        provider,
      };
      const existingPullRequest = input.pullRequestByWorktree.get(row.id);
      const existingChecks = input.checksByWorktree.get(row.id);
      if (existingPullRequest !== undefined) task.existingPullRequest = existingPullRequest;
      if (existingChecks !== undefined) task.existingChecks = existingChecks;

      const groupKey = repositoryGroupKey(git);
      const existingGroup = grouped.get(groupKey);
      if (existingGroup === undefined) {
        grouped.set(groupKey, [task]);
      } else {
        existingGroup.push(task);
      }
    }
    return grouped;
  }

  async function refreshRepositoryRow(
    task: RepositoryRefreshTask,
    signal: AbortSignal,
  ): Promise<void> {
    const pullRequestCacheKey = metadataCacheKey(task, "pull_request");
    const cachedPullRequest = freshPayload(task.existingPullRequest, pullRequestCacheKey);
    const pullRequest =
      cachedPullRequest ?? (await discoverPullRequest(task, pullRequestCacheKey, signal));
    if (pullRequest === undefined || signal.aborted) {
      return;
    }

    const checksCacheKey = metadataCacheKey(task, "checks", pullRequest.number);
    if (freshPayload(task.existingChecks, checksCacheKey) !== undefined) {
      return;
    }
    await refreshChecks(task, checksCacheKey, pullRequest, signal);
  }

  async function discoverPullRequest(
    task: RepositoryRefreshTask,
    cacheKey: string,
    signal: AbortSignal,
  ): Promise<WorktreePullRequest | undefined> {
    const negativeKey = `pull_request:${cacheKey}`;
    if (shouldSkipNegativeRefresh(negativeKey)) {
      return undefined;
    }

    try {
      const pullRequest = await task.provider.discoverPullRequest({
        remote: task.git.remote,
        branch: task.row.branch,
        headSha: task.git.headSha,
        projectId: task.row.projectId,
        worktreeId: task.row.id,
        signal,
      });
      if (pullRequest === null) {
        rememberNegativeRefresh(negativeKey);
        await deleteRepositoryMetadata(task);
        return undefined;
      }
      await upsertPullRequestIfChanged(task, cacheKey, pullRequest);
      return pullRequest;
    } catch (error) {
      if (!signal.aborted) {
        rememberNegativeRefresh(negativeKey);
        await handlePullRequestFailure(task, error);
      }
      return undefined;
    }
  }

  async function refreshChecks(
    task: RepositoryRefreshTask,
    cacheKey: string,
    pullRequest: WorktreePullRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const negativeKey = `checks:${cacheKey}`;
    if (shouldSkipNegativeRefresh(negativeKey)) {
      return;
    }

    try {
      const checks =
        (await task.provider.readChecks({
          remote: task.git.remote,
          pullRequestNumber: pullRequest.number,
          branch: task.row.branch,
          headSha: task.git.headSha,
          projectId: task.row.projectId,
          worktreeId: task.row.id,
          signal,
        })) ?? noChecksSummary(task.provider.id, task.git.checkedAt);
      await upsertChecksIfChanged(task, cacheKey, checks);
    } catch (error) {
      if (!signal.aborted) {
        rememberNegativeRefresh(negativeKey);
        await handleChecksFailure(task, error);
      }
    }
  }

  async function upsertPullRequestIfChanged(
    task: RepositoryRefreshTask,
    cacheKey: string,
    pullRequest: WorktreePullRequest,
  ): Promise<void> {
    if (isFreshSamePayload(task.existingPullRequest, cacheKey, pullRequest)) {
      return;
    }

    const checkedAt = pullRequest.checkedAt ?? task.git.checkedAt;
    await options.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: task.row.id,
      kind: "pull_request",
      payload: pullRequest,
      cacheKey,
      updatedAt: checkedAt,
      expiresAt: addMs(checkedAt, defaultTtlMs),
    });
    options.requestReconcile("metadata:pull_request");
  }

  async function upsertChecksIfChanged(
    task: RepositoryRefreshTask,
    cacheKey: string,
    checks: WorktreeChecksSummary,
  ): Promise<void> {
    if (isFreshSamePayload(task.existingChecks, cacheKey, checks)) {
      return;
    }

    await options.persistence.upsertWorktreeMetadataCurrent({
      worktreeId: task.row.id,
      kind: "checks",
      payload: checks,
      cacheKey,
      updatedAt: checks.checkedAt,
      expiresAt: addMs(checks.checkedAt, checksTtlMs(checks)),
    });
    options.requestReconcile("metadata:checks");
  }

  async function deleteRepositoryMetadata(task: RepositoryRefreshTask): Promise<void> {
    let changed = false;
    if (task.existingPullRequest !== undefined) {
      changed =
        (await options.persistence.deleteWorktreeMetadataCurrent({
          worktreeId: task.row.id,
          kind: "pull_request",
        })) > 0;
    }
    if (task.existingChecks !== undefined) {
      changed =
        (await options.persistence.deleteWorktreeMetadataCurrent({
          worktreeId: task.row.id,
          kind: "checks",
        })) > 0 || changed;
    }
    if (changed) {
      options.requestReconcile("metadata:repository");
    }
  }

  async function handlePullRequestFailure(
    task: RepositoryRefreshTask,
    error: unknown,
  ): Promise<void> {
    const safeError = repositorySafeError(task, error);

    if (task.existingPullRequest === undefined) {
      await logRepositoryFailure(task, "pull_request", safeError);
      return;
    }

    const failedAt = toIsoTimestamp(clock.now());
    const upsertInput: {
      worktreeId: string;
      kind: "pull_request";
      payload: WorktreePullRequest & { stale: true };
      cacheKey?: string;
      updatedAt: string;
      expiresAt: string;
      stale: boolean;
      lastError: SafeError;
    } = {
      worktreeId: task.row.id,
      kind: "pull_request",
      payload: stalePullRequest(task.existingPullRequest.payload),
      updatedAt: failedAt,
      expiresAt: addMs(failedAt, defaultTtlMs),
      stale: true,
      lastError: safeError,
    };
    if (task.existingPullRequest.cacheKey !== undefined) {
      upsertInput.cacheKey = task.existingPullRequest.cacheKey;
    }
    await options.persistence.upsertWorktreeMetadataCurrent(upsertInput);
    options.requestReconcile("metadata:pull_request");
  }

  async function handleChecksFailure(task: RepositoryRefreshTask, error: unknown): Promise<void> {
    const safeError = repositorySafeError(task, error);

    if (task.existingChecks === undefined) {
      await logRepositoryFailure(task, "checks", safeError);
      return;
    }

    const failedAt = toIsoTimestamp(clock.now());
    const upsertInput: {
      worktreeId: string;
      kind: "checks";
      payload: WorktreeChecksSummary & { stale: true };
      cacheKey?: string;
      updatedAt: string;
      expiresAt: string;
      stale: boolean;
      lastError: SafeError;
    } = {
      worktreeId: task.row.id,
      kind: "checks",
      payload: staleChecks(task.existingChecks.payload),
      updatedAt: failedAt,
      expiresAt: addMs(failedAt, defaultTtlMs),
      stale: true,
      lastError: safeError,
    };
    if (task.existingChecks.cacheKey !== undefined) {
      upsertInput.cacheKey = task.existingChecks.cacheKey;
    }
    await options.persistence.upsertWorktreeMetadataCurrent(upsertInput);
    options.requestReconcile("metadata:checks");
  }

  function repositorySafeError(task: RepositoryRefreshTask, error: unknown): SafeError {
    return toSafeError(
      error,
      {
        tag: "RepositoryMetadataError",
        code: "REPOSITORY_METADATA_REFRESH_FAILED",
        message: "Repository metadata refresh failed.",
      },
      {
        projectId: task.row.projectId,
        worktreeId: task.row.id,
      },
    );
  }

  async function logRepositoryFailure(
    task: RepositoryRefreshTask,
    kind: "pull_request" | "checks",
    error: SafeError,
  ): Promise<void> {
    await options.logger?.warn("Repository metadata refresh failed.", {
      projectId: task.row.projectId,
      worktreeId: task.row.id,
      kind,
      error,
    });
  }

  function shouldSkipNegativeRefresh(key: string): boolean {
    const expiresAt = negativeBackoff.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt > clock.now().getTime()) {
      return true;
    }
    negativeBackoff.delete(key);
    return false;
  }

  function rememberNegativeRefresh(key: string): void {
    negativeBackoff.set(key, clock.now().getTime() + (options.negativeBackoffMs ?? defaultTtlMs));
  }

  function repositoryProviderFor(git: RepositoryGitContext): RepositoryProvider | undefined {
    return selectRepositoryProvider(git.remote, repositoryProviders.values());
  }
}

function metadataCacheKey(
  task: RepositoryRefreshTask,
  kind: "pull_request" | "checks",
  pullRequestNumber?: number,
): string {
  const input: Parameters<typeof repositoryMetadataCacheKey>[0] = {
    kind,
    worktreeId: task.row.id,
    path: task.row.path,
    host: task.git.remote.host,
    owner: task.git.remote.owner,
    repo: task.git.remote.repo,
    branch: task.row.branch,
    headSha: task.git.headSha,
  };
  if (pullRequestNumber !== undefined) {
    input.pullRequestNumber = pullRequestNumber;
  }
  return repositoryMetadataCacheKey(input);
}

function freshPayload<TKind extends "pull_request" | "checks">(
  existing: PersistedWorktreeMetadataCurrent<TKind> | undefined,
  cacheKey: string,
): PersistedWorktreeMetadataCurrent<TKind>["payload"] | undefined {
  return existing !== undefined && !existing.expired && existing.cacheKey === cacheKey
    ? existing.payload
    : undefined;
}

function isFreshSamePayload<TKind extends "pull_request" | "checks">(
  existing: PersistedWorktreeMetadataCurrent<TKind> | undefined,
  cacheKey: string,
  payload: PersistedWorktreeMetadataCurrent<TKind>["payload"],
): boolean {
  return (
    existing !== undefined &&
    existing.cacheKey === cacheKey &&
    !existing.expired &&
    !existing.stale &&
    JSON.stringify(existing.payload) === JSON.stringify(payload)
  );
}

function repositoryProviderMap(
  providers: Iterable<RepositoryProvider> | Map<string, RepositoryProvider> | undefined,
): Map<string, RepositoryProvider> {
  if (providers instanceof Map) {
    return new Map(providers);
  }
  return new Map(Array.from(providers ?? []).map((provider) => [provider.id, provider]));
}

function repositoryGroupKey(git: RepositoryGitContext): string {
  return `${git.remote.host.toLowerCase()}/${git.remote.owner.toLowerCase()}/${git.remote.repo.toLowerCase()}`;
}

function noChecksSummary(source: string, checkedAt: string): WorktreeChecksSummary {
  return {
    state: "none",
    source,
    checkedAt,
  };
}

function checksTtlMs(checks: WorktreeChecksSummary): number {
  return checks.state === "running" ? runningChecksTtlMs : defaultTtlMs;
}
