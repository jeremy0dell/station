import type {
  ProviderProjectConfig,
  RepositoryProvider,
  StationSnapshot,
  WorktreeChangeSummary,
  WorktreePullRequest,
} from "@station/contracts";
import {
  forEachConcurrent,
  type RuntimeClock,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { toSafeError } from "../diagnostics/errors.js";
import type {
  PersistedWorktreeMetadataCurrent,
  WorktreeMetadataStore,
} from "../persistence/index.js";
import type { StationLogger } from "../stationLogger.js";
import { addMs } from "../utils/time.js";
import type {
  WorktreeChangeReadInput,
  WorktreeChangeSource,
  WorktreeMetadataInvalidationSource,
} from "./ports.js";
import {
  type CreateRepositoryMetadataRefresherOptions,
  createRepositoryMetadataRefresher,
} from "./repositoryRefresh.js";
import { staleChangeSummary } from "./stalePayloads.js";

/**
 * USE CASE
 *
 * Refreshes and persists local-change and code-host metadata for snapshot worktrees through application-owned sources.
 */
export type WorktreeMetadataRefreshService = {
  refresh(snapshot: StationSnapshot): Promise<void>;
  shutdown(): Promise<void>;
};

export type CreateWorktreeMetadataRefreshServiceOptions = {
  projects: ProviderProjectConfig[];
  persistence: WorktreeMetadataStore;
  requestReconcile(reason: string): void;
  clock?: RuntimeClock;
  logger?: StationLogger;
  worktreeChangeSource: WorktreeChangeSource;
  worktreeMetadataInvalidationSource: WorktreeMetadataInvalidationSource;
  repositoryProviders?: Iterable<RepositoryProvider> | Map<string, RepositoryProvider>;
  ttlMs?: number;
  concurrency?: number;
  repositoryConcurrency?: number;
  repositoryNegativeBackoffMs?: number;
};

const defaultTtlMs = 5 * 60 * 1000;
const defaultConcurrency = 2;

export function createWorktreeMetadataRefreshService(
  options: CreateWorktreeMetadataRefreshServiceOptions,
): WorktreeMetadataRefreshService {
  const clock = options.clock ?? systemClock;
  const projectsById = new Map(options.projects.map((project) => [project.id, project]));
  const concurrency = options.concurrency ?? defaultConcurrency;
  const repositoryOptions: CreateRepositoryMetadataRefresherOptions = {
    projectsById,
    persistence: options.persistence,
    requestReconcile: options.requestReconcile,
    clock,
  };
  if (options.logger !== undefined) repositoryOptions.logger = options.logger;
  if (options.repositoryProviders !== undefined) {
    repositoryOptions.repositoryProviders = options.repositoryProviders;
  }
  if (options.repositoryConcurrency !== undefined) {
    repositoryOptions.repositoryConcurrency = options.repositoryConcurrency;
  }
  if (options.repositoryNegativeBackoffMs !== undefined) {
    repositoryOptions.negativeBackoffMs = options.repositoryNegativeBackoffMs;
  }
  const repositoryRefresher = createRepositoryMetadataRefresher(repositoryOptions);
  let pendingSnapshot: StationSnapshot | undefined;
  let running: Promise<void> | undefined;
  let shutdownRequested = false;
  let controller: AbortController | undefined;

  return {
    refresh: async (snapshot) => {
      if (shutdownRequested) {
        return;
      }

      pendingSnapshot = snapshot;
      if (running !== undefined) {
        await running;
        return;
      }

      controller = new AbortController();
      running = runPendingRefreshes(controller.signal).finally(() => {
        running = undefined;
        controller = undefined;
      });
      await running;
    },
    shutdown: async () => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      pendingSnapshot = undefined;
      controller?.abort();
      options.worktreeMetadataInvalidationSource.shutdown();
      await running?.catch(() => undefined);
    },
  };

  async function runPendingRefreshes(signal: AbortSignal): Promise<void> {
    while (pendingSnapshot !== undefined && !signal.aborted) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = undefined;
      await refreshSnapshot(snapshot, signal);
    }
  }

  async function refreshSnapshot(snapshot: StationSnapshot, signal: AbortSignal): Promise<void> {
    options.worktreeMetadataInvalidationSource.replaceWatchedWorktrees(
      snapshot.rows
        .filter((row) => row.worktree.state === "exists")
        .map((row) => ({ worktreeId: row.id, path: row.path, branch: row.branch })),
    );

    const referenceTime = toIsoTimestamp(clock.now());
    const [changeRows, pullRequestRows, checksRows] = await Promise.all([
      options.persistence.listWorktreeMetadataCurrent({
        kind: "change_summary",
        includeExpired: true,
        now: referenceTime,
      }),
      options.persistence.listWorktreeMetadataCurrent({
        kind: "pull_request",
        includeExpired: true,
        now: referenceTime,
      }),
      options.persistence.listWorktreeMetadataCurrent({
        kind: "checks",
        includeExpired: true,
        now: referenceTime,
      }),
    ]);

    const changeByWorktree = new Map(changeRows.map((row) => [row.worktreeId, row]));
    const pullRequestByWorktree = new Map(pullRequestRows.map((row) => [row.worktreeId, row]));
    const checksByWorktree = new Map(checksRows.map((row) => [row.worktreeId, row]));

    await forEachConcurrent(snapshot.rows, { concurrency }, async (row) => {
      if (signal.aborted) {
        return;
      }
      const project = projectsById.get(row.projectId);
      if (project === undefined) {
        return;
      }
      const localInput: {
        project: ProviderProjectConfig;
        row: StationSnapshot["rows"][number];
        signal: AbortSignal;
        existing?: PersistedWorktreeMetadataCurrent<"change_summary">;
        cachedPullRequest?: WorktreePullRequest;
      } = {
        project,
        row,
        signal,
      };
      const existing = changeByWorktree.get(row.id);
      const cachedPullRequest = pullRequestByWorktree.get(row.id)?.payload;
      if (existing !== undefined) localInput.existing = existing;
      if (cachedPullRequest !== undefined) localInput.cachedPullRequest = cachedPullRequest;
      await refreshLocalGitRow(localInput);
    });

    await repositoryRefresher.refresh({
      snapshot,
      pullRequestByWorktree,
      checksByWorktree,
      signal,
    });
  }

  async function refreshLocalGitRow(input: {
    project: ProviderProjectConfig;
    row: StationSnapshot["rows"][number];
    signal: AbortSignal;
    existing?: PersistedWorktreeMetadataCurrent<"change_summary">;
    cachedPullRequest?: WorktreePullRequest;
  }): Promise<void> {
    if (shouldBackOffFailedRefresh(input.existing)) {
      return;
    }
    if (input.row.worktree.state !== "exists") {
      await deleteExistingChangeSummary(input.row.id, input.existing);
      return;
    }

    try {
      const worktree: WorktreeChangeReadInput["worktree"] = {
        id: input.row.id,
        projectId: input.row.projectId,
        path: input.row.path,
        branch: input.row.branch,
      };
      if (input.row.worktree.pr !== undefined) {
        worktree.pullRequest = input.row.worktree.pr;
      }

      const summaryInput: WorktreeChangeReadInput = {
        project: input.project,
        worktree,
        signal: input.signal,
      };
      if (input.cachedPullRequest !== undefined) {
        summaryInput.cachedPullRequest = input.cachedPullRequest;
      }
      const result = await options.worktreeChangeSource.read(summaryInput);
      if (input.signal.aborted) return;

      if (result === undefined) {
        await deleteExistingChangeSummary(input.row.id, input.existing);
        return;
      }

      if (
        input.existing !== undefined &&
        !input.existing.expired &&
        input.existing.cacheKey === result.cacheKey
      ) {
        return;
      }

      await options.persistence.upsertWorktreeMetadataCurrent({
        worktreeId: input.row.id,
        kind: "change_summary",
        payload: result.summary,
        cacheKey: result.cacheKey,
        updatedAt: result.summary.checkedAt,
        expiresAt: addMs(result.summary.checkedAt, options.ttlMs ?? defaultTtlMs),
      });
      options.requestReconcile("metadata:change_summary");
    } catch (error) {
      if (!input.signal.aborted) {
        await handleLocalRefreshFailure(input, error);
      }
    }
  }

  async function deleteExistingChangeSummary(
    worktreeId: string,
    existing: PersistedWorktreeMetadataCurrent<"change_summary"> | undefined,
  ): Promise<void> {
    if (existing === undefined) {
      return;
    }
    const deleted = await options.persistence.deleteWorktreeMetadataCurrent({
      worktreeId,
      kind: "change_summary",
    });
    if (deleted > 0) {
      options.requestReconcile("metadata:change_summary");
    }
  }

  async function handleLocalRefreshFailure(
    input: {
      row: StationSnapshot["rows"][number];
      existing?: PersistedWorktreeMetadataCurrent<"change_summary">;
    },
    error: unknown,
  ): Promise<void> {
    const safeError = toSafeError(
      error,
      {
        tag: "LocalGitMetadataError",
        code: "LOCAL_GIT_CHANGE_SUMMARY_FAILED",
        message: "Local git change summary refresh failed.",
      },
      {
        projectId: input.row.projectId,
        worktreeId: input.row.id,
      },
    );

    if (input.existing !== undefined) {
      const failedAt = toIsoTimestamp(clock.now());
      const stalePayload = staleChangeSummary(input.existing.payload);
      const upsertInput: {
        worktreeId: string;
        kind: "change_summary";
        payload: WorktreeChangeSummary;
        cacheKey?: string;
        expiresAt: string;
        updatedAt: string;
        stale: boolean;
        lastError: typeof safeError;
      } = {
        worktreeId: input.row.id,
        kind: "change_summary",
        payload: stalePayload,
        expiresAt: addMs(failedAt, options.ttlMs ?? defaultTtlMs),
        updatedAt: failedAt,
        stale: true,
        lastError: safeError,
      };
      if (input.existing.cacheKey !== undefined) {
        upsertInput.cacheKey = input.existing.cacheKey;
      }
      await options.persistence.upsertWorktreeMetadataCurrent(upsertInput);
      options.requestReconcile("metadata:change_summary");
      return;
    }

    await options.logger?.warn("Local git metadata refresh failed.", {
      projectId: input.row.projectId,
      worktreeId: input.row.id,
      error: safeError,
    });
  }
}

function shouldBackOffFailedRefresh(
  existing: PersistedWorktreeMetadataCurrent<"change_summary"> | undefined,
): boolean {
  return existing?.stale === true && existing.lastError !== undefined && !existing.expired;
}
