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
  WorktreeChangeReadRequest,
  WorktreeChangeSource,
  WorktreeMetadataInvalidationSource,
  WorktreeMetadataTarget,
} from "./ports.js";
import {
  type CreateRepositoryMetadataRefresherOptions,
  createRepositoryMetadataRefresher,
} from "./repositoryRefresh.js";
import { staleChangeSummary } from "./stalePayloads.js";

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

/**
 * USE CASE
 *
 * Refreshes and persists local-change and repository metadata through
 * purpose-owned evidence and invalidation ports.
 *
 * Shutdown aborts current reads before invalidation teardown and prevents late
 * source completions from mutating metadata.
 */
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
  let shutdownFlight: Promise<void> | undefined;
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
      shutdownFlight ??= performShutdown();
      await shutdownFlight;
    },
  };

  async function runPendingRefreshes(signal: AbortSignal): Promise<void> {
    while (pendingSnapshot !== undefined && !signal.aborted) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = undefined;
      await refreshSnapshot(snapshot, signal);
    }
  }

  async function performShutdown(): Promise<void> {
    shutdownRequested = true;
    pendingSnapshot = undefined;
    controller?.abort();
    try {
      await options.worktreeMetadataInvalidationSource.shutdown();
    } finally {
      await running?.catch(() => undefined);
    }
  }

  async function refreshSnapshot(snapshot: StationSnapshot, signal: AbortSignal): Promise<void> {
    const watchedTargets = snapshot.rows
      .filter((row) => row.worktree.state === "exists")
      .map(worktreeMetadataTargetFromRow);
    await options.worktreeMetadataInvalidationSource.replaceWatchedWorktrees(watchedTargets);
    if (signal.aborted) return;

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

    try {
      const request: WorktreeChangeReadRequest = {
        target: worktreeMetadataTargetFromRow(input.row),
        baseSelection: {},
        signal: input.signal,
      };
      const observedPullRequestBase = input.row.worktree.pr?.baseRef;
      if (observedPullRequestBase !== undefined) {
        request.baseSelection.observedPullRequestBase = observedPullRequestBase;
      }
      const cachedPullRequestBase = input.cachedPullRequest?.baseRef;
      if (cachedPullRequestBase !== undefined) {
        request.baseSelection.cachedPullRequestBase = cachedPullRequestBase;
      }
      if (input.project.defaultBranch !== undefined) {
        request.baseSelection.defaultBranch = input.project.defaultBranch;
      }
      if (input.project.worktrunk.base !== undefined) {
        request.baseSelection.worktrunkBase = input.project.worktrunk.base;
      }

      const result = await options.worktreeChangeSource.read(request);
      if (input.signal.aborted || shutdownRequested) return;

      switch (result.status) {
        case "superseded":
          return;
        case "unavailable":
          await deleteExistingChangeSummary(input.row.id, input.existing, input.signal);
          return;
        case "available":
          break;
      }

      if (
        input.existing !== undefined &&
        !input.existing.expired &&
        input.existing.cacheKey === result.evidence.cacheKey
      ) {
        return;
      }

      await options.persistence.upsertWorktreeMetadataCurrent({
        worktreeId: input.row.id,
        kind: "change_summary",
        payload: result.evidence.summary,
        cacheKey: result.evidence.cacheKey,
        updatedAt: result.evidence.summary.checkedAt,
        expiresAt: addMs(result.evidence.summary.checkedAt, options.ttlMs ?? defaultTtlMs),
      });
      if (input.signal.aborted || shutdownRequested) return;
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
    signal: AbortSignal,
  ): Promise<void> {
    if (existing === undefined || signal.aborted || shutdownRequested) {
      return;
    }
    const deleted = await options.persistence.deleteWorktreeMetadataCurrent({
      worktreeId,
      kind: "change_summary",
    });
    if (deleted > 0 && !signal.aborted && !shutdownRequested) {
      options.requestReconcile("metadata:change_summary");
    }
  }

  async function handleLocalRefreshFailure(
    input: {
      row: StationSnapshot["rows"][number];
      signal: AbortSignal;
      existing?: PersistedWorktreeMetadataCurrent<"change_summary">;
    },
    error: unknown,
  ): Promise<void> {
    if (input.signal.aborted || shutdownRequested) return;
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
      if (!input.signal.aborted && !shutdownRequested) {
        options.requestReconcile("metadata:change_summary");
      }
      return;
    }

    await options.logger?.warn("Local git metadata refresh failed.", {
      projectId: input.row.projectId,
      worktreeId: input.row.id,
      error: safeError,
    });
  }
}

function worktreeMetadataTargetFromRow(
  row: StationSnapshot["rows"][number],
): WorktreeMetadataTarget {
  const target: WorktreeMetadataTarget = {
    worktreeId: row.id,
    projectId: row.projectId,
    branch: row.branch,
  };
  if (row.registrationIdentity !== undefined) {
    target.registrationIdentity = row.registrationIdentity;
  }
  return target;
}

function shouldBackOffFailedRefresh(
  existing: PersistedWorktreeMetadataCurrent<"change_summary"> | undefined,
): boolean {
  return existing?.stale === true && existing.lastError !== undefined && !existing.expired;
}
