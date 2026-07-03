import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessProvider,
  HarnessRunObservation,
  HarnessStatusObservation,
  ProviderHealth,
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  SnapshotHarness,
  StationSnapshot,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import {
  durationMs,
  pathIsSameOrInside,
  type RuntimeClock,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  toIsoTimestamp,
} from "@station/runtime";
import { staleChangeSummary, staleChecks, stalePullRequest } from "../metadata/stalePayloads.js";
import type { ObserverPersistence } from "../persistence/index.js";
import { providerObservationRetentionDays } from "../persistence/retention.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ReconcileTiming } from "./core.js";
import { buildStationSnapshot, safeErrorToProviderHealth } from "./graph.js";
import { applyHarnessEventStatusOverlays, type ObserverHarnessRun } from "./harnessEventStatus.js";

export type ProviderReadOptions = {
  clock: RuntimeClock;
  timeoutMs: number;
  retries: number;
  logger?: JsonlLogger;
};

export type ReconcileOnceInput = {
  reason: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
  };
  projects: ProviderProjectConfig[];
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  persistence?: ObserverPersistence;
  providerObservationRetentionDays?: number;
  featureFlags?: ClientFeatureFlags;
};

export type ReconcileOnceResult = {
  snapshot: StationSnapshot;
  providerHealth: Record<string, ProviderHealth>;
  lastReconcile: ReconcileTiming;
};

export function buildInitialSnapshot(input: {
  generatedAt: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
  };
  projects: ProviderProjectConfig[];
  worktreeProviderId: ProviderId;
  harnesses?: SnapshotHarness[];
  featureFlags?: ClientFeatureFlags;
}): StationSnapshot {
  return buildStationSnapshot({
    generatedAt: input.generatedAt,
    observer: {
      ...input.observer,
      healthy: true,
    },
    projects: input.projects,
    worktreeProviderId: input.worktreeProviderId,
    providerHealth: {},
    ...(input.harnesses === undefined ? {} : { harnesses: input.harnesses }),
    worktrees: [],
    terminalTargets: [],
    harnessRuns: [],
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
  });
}

export async function runReconcileOnce(input: ReconcileOnceInput): Promise<ReconcileOnceResult> {
  const started = toIsoTimestamp(input.read.clock.now());
  const retentionDays =
    input.providerObservationRetentionDays ?? providerObservationRetentionDays();
  await input.read.logger?.info("Reconcile started.", { reason: input.reason });
  if (input.persistence !== undefined) {
    await input.persistence.pruneExpiredProviderObservations(started);
  }
  const errors: SafeError[] = [];
  const providerHealth: Record<string, ProviderHealth> = {};

  const worktreeResult = await readWorktreeObservations({
    providers: input.providers,
    projects: input.projects,
    read: input.read,
    providerHealth,
    errors,
  });
  const terminalResult = await readTerminalTargetObservations({
    providers: input.providers,
    read: input.read,
    providerHealth,
    errors,
  });
  const terminalTargets = normalizeTerminalTargetsForCurrentWorktrees({
    terminalTargets: terminalResult.terminalTargets,
    worktrees: worktreeResult.worktrees,
  });
  const harnessResult = await readHarnessObservations({
    providers: input.providers,
    projects: input.projects,
    worktrees: worktreeResult.worktrees,
    terminalTargets,
    read: input.read,
    providerHealth,
    errors,
  });
  await readRepositoryProviderHealth({
    providers: input.providers,
    read: input.read,
    providerHealth,
    errors,
  });

  const finishedAt = toIsoTimestamp(input.read.clock.now());
  const harnessStatusInput: {
    persistence?: ObserverPersistence;
    harnessRuns: ObserverHarnessRun[];
    now: string;
  } = {
    harnessRuns: harnessResult.harnessRuns,
    now: finishedAt,
  };
  if (input.persistence !== undefined) {
    harnessStatusInput.persistence = input.persistence;
  }
  const harnessRunsWithStatus = await harnessRunsWithPersistedEventStatus(harnessStatusInput);
  const harnessRuns = normalizeHarnessRunsForCurrentWorktrees({
    harnessRuns: harnessRunsWithStatus,
    worktrees: worktreeResult.worktrees,
    terminalTargets,
  });
  const metadataInput: {
    persistence?: ObserverPersistence;
    worktrees: WorktreeObservation[];
    now: string;
  } = {
    worktrees: worktreeResult.worktrees,
    now: finishedAt,
  };
  if (input.persistence !== undefined) {
    metadataInput.persistence = input.persistence;
  }
  const worktreesForSnapshot = await worktreesWithCachedMetadata(metadataInput);
  const sessionMetadata =
    input.persistence === undefined ? [] : await input.persistence.listSessions();
  const recoveryHandles =
    input.persistence === undefined ? [] : await input.persistence.listSessionRecoveryHandles();
  const turnReadiness =
    input.persistence === undefined ? [] : await input.persistence.listSessionTurnReadiness();
  const lastReconcile: ReconcileTiming = {
    reason: input.reason,
    startedAt: started,
    finishedAt,
    durationMs: durationMs(started, finishedAt),
    projectsScanned: worktreeResult.projectsScanned,
    worktreesObserved: worktreeResult.worktrees.length,
    terminalTargetsObserved: terminalTargets.length,
    harnessRunsObserved: harnessRuns.length,
    eventsEmitted: 0,
    errors,
  };
  const snapshot = buildStationSnapshot({
    generatedAt: finishedAt,
    observer: input.observer,
    projects: input.projects,
    worktreeProviderId: input.providers.worktree.id,
    providerHealth,
    harnesses: harnessesFromRegistry(input.providers),
    harnessCapabilities: harnessResult.harnessCapabilities,
    worktrees: worktreesForSnapshot,
    terminalTargets,
    harnessRuns,
    sessionMetadata,
    recoveryHandles,
    turnReadiness,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
  });

  lastReconcile.eventsEmitted = await persistReconcileResult({
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    projects: input.projects,
    worktrees: worktreeResult.worktrees,
    terminalTargets,
    harnessRuns: harnessRuns.map((harnessRun) => harnessRun.run),
    providerHealth,
    observedAt: finishedAt,
    providerObservationRetentionDays: retentionDays,
  });

  await input.read.logger?.info("Reconcile finished.", {
    reason: input.reason,
    durationMs: lastReconcile.durationMs,
    projectsScanned: worktreeResult.projectsScanned,
    worktreesObserved: worktreeResult.worktrees.length,
    terminalTargetsObserved: terminalResult.terminalTargets.length,
    harnessRunsObserved: harnessRuns.length,
    errorCount: errors.length,
  });

  return {
    snapshot,
    providerHealth,
    lastReconcile,
  };
}

export function harnessesFromRegistry(providers: ProviderRegistry): SnapshotHarness[] {
  return Array.from(providers.harnesses.values()).map((provider) => {
    const harness: SnapshotHarness = { id: provider.id, label: provider.id };
    const version = providers.harnessVersions.get(provider.id);
    if (version?.installedVersion !== undefined) {
      harness.installedVersion = version.installedVersion;
    }
    if (version?.latestVersion !== undefined) {
      harness.latestVersion = version.latestVersion;
    }
    if (harness.installedVersion !== undefined && harness.latestVersion !== undefined) {
      harness.updateAvailable = harness.installedVersion !== harness.latestVersion;
    }
    return harness;
  });
}

function normalizeTerminalTargetsForCurrentWorktrees(input: {
  terminalTargets: TerminalTargetObservation[];
  worktrees: WorktreeObservation[];
}): TerminalTargetObservation[] {
  return input.terminalTargets.map((target) => {
    const worktree = resolveTerminalTargetWorktree(target, input.worktrees);
    if (worktree === undefined || target.worktreeId === worktree.id) {
      return target;
    }
    return {
      ...target,
      worktreeId: worktree.id,
    };
  });
}

function resolveTerminalTargetWorktree(
  target: TerminalTargetObservation,
  worktrees: readonly WorktreeObservation[],
): WorktreeObservation | undefined {
  if (target.projectId !== undefined && target.cwd !== undefined) {
    const cwdWorktree = resolveWorktreeByProjectPath({
      projectId: target.projectId,
      cwd: target.cwd,
      worktrees,
    });
    if (cwdWorktree !== undefined) {
      return cwdWorktree;
    }
  }
  if (target.worktreeId !== undefined) {
    const claimed = worktrees.find((worktree) => worktree.id === target.worktreeId);
    if (claimed !== undefined) {
      return claimed;
    }
  }
  return undefined;
}

function normalizeHarnessRunsForCurrentWorktrees(input: {
  harnessRuns: ObserverHarnessRun[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
}): ObserverHarnessRun[] {
  return input.harnessRuns.map((harnessRun) => {
    const worktree = resolveHarnessRunWorktree({
      run: harnessRun.run,
      worktrees: input.worktrees,
      terminalTargets: input.terminalTargets,
    });
    if (worktree === undefined || harnessRun.run.worktreeId === worktree.id) {
      return harnessRun;
    }
    return {
      ...harnessRun,
      run: {
        ...harnessRun.run,
        worktreeId: worktree.id,
      },
    };
  });
}

function resolveHarnessRunWorktree(input: {
  run: HarnessRunObservation;
  worktrees: readonly WorktreeObservation[];
  terminalTargets: readonly TerminalTargetObservation[];
}): WorktreeObservation | undefined {
  if (input.run.projectId !== undefined && input.run.cwd !== undefined) {
    const cwdWorktree = resolveWorktreeByProjectPath({
      projectId: input.run.projectId,
      cwd: input.run.cwd,
      worktrees: input.worktrees,
    });
    if (cwdWorktree !== undefined) {
      return cwdWorktree;
    }
  }
  if (input.run.sessionId !== undefined) {
    const terminal = input.terminalTargets.find(
      (target) => target.sessionId === input.run.sessionId && target.worktreeId !== undefined,
    );
    if (terminal?.worktreeId !== undefined) {
      const terminalWorktree = input.worktrees.find(
        (worktree) => worktree.id === terminal.worktreeId,
      );
      if (terminalWorktree !== undefined) {
        return terminalWorktree;
      }
    }
  }
  if (input.run.worktreeId !== undefined) {
    const claimed = input.worktrees.find((worktree) => worktree.id === input.run.worktreeId);
    if (claimed !== undefined) {
      return claimed;
    }
  }
  return undefined;
}

function resolveWorktreeByProjectPath(input: {
  projectId: string;
  cwd: string;
  worktrees: readonly WorktreeObservation[];
}): WorktreeObservation | undefined {
  const matches = input.worktrees
    .filter(
      (worktree) =>
        worktree.projectId === input.projectId && pathIsSameOrInside(input.cwd, worktree.path),
    )
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        left.id.localeCompare(right.id) ||
        left.path.localeCompare(right.path),
    );
  const match = matches[0];
  if (match === undefined) {
    return undefined;
  }
  const next = matches[1];
  if (next !== undefined && next.path.length === match.path.length) {
    return undefined;
  }
  return match;
}

async function readWorktreeObservations(input: {
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  worktrees: WorktreeObservation[];
  projectsScanned: number;
}> {
  const provider = input.providers.worktree;
  const capabilities = provider.capabilities();
  const worktrees: WorktreeObservation[] = [];
  let projectsScanned = 0;

  input.providerHealth[provider.id] = await readProviderHealth({
    providerId: provider.id,
    providerType: "worktree",
    capabilities,
    clock: input.read.clock,
    timeoutMs: input.read.timeoutMs,
    retries: input.read.retries,
    health: () => provider.health(),
    errors: input.errors,
  });

  for (const project of input.projects) {
    const result = await runProviderReadBoundary(
      {
        operation: `provider.${provider.id}.listWorktrees`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_LIST_FAILED",
          message: "The worktree provider failed to list worktrees.",
          provider: provider.id,
        },
      },
      () => provider.listWorktrees(project),
    );
    if (!result.ok) {
      input.errors.push(result.error);
      await input.read.logger?.error("Worktree provider list failed.", {
        provider: provider.id,
        error: result.error,
        durationMs: result.timing.durationMs,
      });
      input.providerHealth[provider.id] = failedProviderHealth({
        providerId: provider.id,
        providerType: "worktree",
        lastCheckedAt: result.timing.finishedAt,
        lastError: result.error,
        latencyMs: result.timing.durationMs,
        capabilities,
      });
      break;
    }

    projectsScanned += 1;
    worktrees.push(...result.value);
  }

  return { worktrees, projectsScanned };
}

async function readTerminalTargetObservations(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  terminalTargets: TerminalTargetObservation[];
}> {
  const terminalTargets: TerminalTargetObservation[] = [];

  for (const provider of input.providers.terminals.values()) {
    const capabilities = provider.capabilities();

    input.providerHealth[provider.id] = await readProviderHealth({
      providerId: provider.id,
      providerType: "terminal",
      capabilities,
      clock: input.read.clock,
      timeoutMs: input.read.timeoutMs,
      retries: input.read.retries,
      health: () => provider.health(),
      errors: input.errors,
    });

    const result = await runProviderReadBoundary(
      {
        operation: `provider.${provider.id}.listTargets`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "TerminalProviderError",
          code: "TERMINAL_LIST_FAILED",
          message: "The terminal provider failed to list targets.",
          provider: provider.id,
        },
      },
      () => provider.listTargets(),
    );
    if (result.ok) {
      terminalTargets.push(...result.value);
    } else {
      input.errors.push(result.error);
      await input.read.logger?.error("Terminal provider list failed.", {
        provider: provider.id,
        error: result.error,
        durationMs: result.timing.durationMs,
      });
      input.providerHealth[provider.id] = failedProviderHealth({
        providerId: provider.id,
        providerType: "terminal",
        lastCheckedAt: result.timing.finishedAt,
        lastError: result.error,
        latencyMs: result.timing.durationMs,
        capabilities,
      });
    }
  }

  return { terminalTargets };
}

async function readHarnessObservations(input: {
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  harnessRuns: ObserverHarnessRun[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
}> {
  const harnessRuns: ObserverHarnessRun[] = [];
  const harnessCapabilities: Record<string, HarnessCapabilities> = {};

  for (const provider of input.providers.harnesses.values()) {
    const capabilities = provider.capabilities();
    harnessCapabilities[provider.id] = capabilities;
    input.providerHealth[provider.id] = await readProviderHealth({
      providerId: provider.id,
      providerType: "harness",
      capabilities,
      clock: input.read.clock,
      timeoutMs: input.read.timeoutMs,
      retries: input.read.retries,
      health: () => provider.health(),
      errors: input.errors,
    });

    const result = await runProviderReadBoundary(
      {
        operation: `provider.${provider.id}.discoverRuns`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_DISCOVER_FAILED",
          message: "The harness provider failed to discover runs.",
          provider: provider.id,
        },
      },
      () =>
        provider.discoverRuns({
          projects: input.projects,
          worktrees: input.worktrees,
          terminalTargets: input.terminalTargets,
        }),
    );

    if (result.ok) {
      const classifiedRuns = await classifyHarnessRuns({
        provider,
        capabilities,
        runs: result.value,
        projects: input.projects,
        worktrees: input.worktrees,
        terminalTargets: input.terminalTargets,
        read: input.read,
        providerHealth: input.providerHealth,
        errors: input.errors,
      });
      harnessRuns.push(...classifiedRuns);
      continue;
    }

    input.errors.push(result.error);
    await input.read.logger?.error("Harness provider discovery failed.", {
      provider: provider.id,
      error: result.error,
      durationMs: result.timing.durationMs,
    });
    input.providerHealth[provider.id] = failedProviderHealth({
      providerId: provider.id,
      providerType: "harness",
      lastCheckedAt: result.timing.finishedAt,
      lastError: result.error,
      latencyMs: result.timing.durationMs,
      capabilities,
    });
  }

  return { harnessRuns, harnessCapabilities };
}

async function readRepositoryProviderHealth(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<void> {
  for (const provider of input.providers.repositories.values()) {
    const capabilities = provider.capabilities();
    input.providerHealth[provider.id] = await readProviderHealth({
      providerId: provider.id,
      providerType: "repository",
      capabilities,
      clock: input.read.clock,
      timeoutMs: input.read.timeoutMs,
      retries: input.read.retries,
      health: () => provider.health(),
      errors: input.errors,
    });
  }
}

async function classifyHarnessRuns(input: {
  provider: HarnessProvider;
  capabilities: HarnessCapabilities;
  runs: HarnessRunObservation[];
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<ObserverHarnessRun[]> {
  const classifiedRuns: ObserverHarnessRun[] = [];
  for (const run of input.runs) {
    const classification = await runProviderReadBoundary(
      {
        operation: `provider.${input.provider.id}.classifyRun`,
        clock: input.read.clock,
        timeoutMs: input.read.timeoutMs,
        retries: input.read.retries,
        error: {
          tag: "HarnessProviderError",
          code: "HARNESS_CLASSIFY_FAILED",
          message: "The harness provider failed to classify a run.",
          provider: input.provider.id,
        },
      },
      () =>
        input.provider.classifyRun(run, {
          projects: input.projects,
          worktrees: input.worktrees,
          terminalTargets: input.terminalTargets,
        }),
    );

    if (classification.ok) {
      classifiedRuns.push(runWithStatus(run, classification.value));
      continue;
    }

    input.errors.push(classification.error);
    await input.read.logger?.error("Harness provider classification failed.", {
      provider: input.provider.id,
      error: classification.error,
      durationMs: classification.timing.durationMs,
    });
    input.providerHealth[input.provider.id] = failedProviderHealth({
      providerId: input.provider.id,
      providerType: "harness",
      lastCheckedAt: classification.timing.finishedAt,
      lastError: classification.error,
      latencyMs: classification.timing.durationMs,
      capabilities: input.capabilities,
    });
  }

  return classifiedRuns;
}

async function harnessRunsWithPersistedEventStatus(input: {
  persistence?: ObserverPersistence;
  harnessRuns: ObserverHarnessRun[];
  now: string;
}): Promise<ObserverHarnessRun[]> {
  if (input.persistence === undefined) {
    return input.harnessRuns;
  }

  const observations = await input.persistence.listProviderObservations({
    entityKind: "harness_event",
    now: input.now,
  });
  return applyHarnessEventStatusOverlays({
    runs: input.harnessRuns,
    observations,
  });
}

async function persistReconcileResult(input: {
  persistence?: ObserverPersistence;
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  providerHealth: Record<string, ProviderHealth>;
  observedAt: string;
  providerObservationRetentionDays: number;
}): Promise<number> {
  if (input.persistence === undefined) {
    return 0;
  }

  await input.persistence.persistReconcileResult({
    projects: input.projects,
    worktrees: input.worktrees,
    terminalTargets: input.terminalTargets,
    harnessRuns: input.harnessRuns,
    providerHealth: input.providerHealth,
    observedAt: input.observedAt,
    providerObservationRetentionDays: input.providerObservationRetentionDays,
  });
  await input.persistence.recordEvent(
    {
      type: "observer.reconciled",
      at: input.observedAt,
      changed: 0,
    },
    { createdAt: input.observedAt },
  );

  return 1;
}

async function worktreesWithCachedMetadata(input: {
  persistence?: ObserverPersistence;
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

async function readProviderHealth(input: {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  capabilities: Record<string, boolean>;
  clock: RuntimeClock;
  timeoutMs: number;
  retries: number;
  health: () => Promise<ProviderHealth>;
  errors: SafeError[];
}): Promise<ProviderHealth> {
  const result = await runProviderReadBoundary(
    {
      operation: `provider.${input.providerId}.health`,
      clock: input.clock,
      timeoutMs: input.timeoutMs,
      retries: input.retries,
      error: {
        tag: "ProviderUnavailableError",
        code: "PROVIDER_HEALTH_FAILED",
        message: "The provider health check failed.",
        provider: input.providerId,
      },
    },
    input.health,
  );

  if (result.ok) {
    return {
      ...result.value,
      latencyMs: result.value.latencyMs ?? result.timing.durationMs,
      capabilities: result.value.capabilities ?? input.capabilities,
    };
  }

  input.errors.push(result.error);
  return failedProviderHealth({
    providerId: input.providerId,
    providerType: input.providerType,
    lastCheckedAt: result.timing.finishedAt,
    lastError: result.error,
    latencyMs: result.timing.durationMs,
    capabilities: input.capabilities,
  });
}

function runProviderReadBoundary<T>(
  input: {
    operation: string;
    clock: RuntimeClock;
    timeoutMs: number;
    retries: number;
    error: {
      tag: string;
      code: string;
      message: string;
      provider: string;
    };
  },
  task: () => Promise<T>,
) {
  return runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: input.operation,
      clock: input.clock,
      timeoutMs: input.timeoutMs,
      error: input.error,
      timeoutError: {
        tag: "TimeoutError",
        code: "PROVIDER_TIMEOUT",
        message: "Provider operation timed out.",
        provider: input.error.provider,
      },
      retry: {
        retries: input.retries,
        delayMs: 10,
      },
    },
    task,
  );
}

function failedProviderHealth(input: {
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  lastCheckedAt: string;
  lastError: SafeError;
  latencyMs: number;
  capabilities: Record<string, boolean>;
}): ProviderHealth {
  return safeErrorToProviderHealth({
    providerId: input.providerId,
    providerType: input.providerType,
    lastCheckedAt: input.lastCheckedAt,
    lastError: safeErrorFromUnknown(input.lastError, {
      tag: input.lastError.tag,
      code: input.lastError.code,
      message: input.lastError.message,
      provider: input.providerId,
    }),
    latencyMs: input.latencyMs,
    capabilities: input.capabilities,
  });
}

function runWithStatus(
  run: HarnessRunObservation,
  classification: HarnessStatusObservation,
): ObserverHarnessRun {
  const nextRun: HarnessRunObservation = {
    id: run.id,
    provider: run.provider,
    state: classification.status.value,
    confidence: classification.status.confidence,
    reason: classification.status.reason,
    observedAt: run.observedAt,
  };
  const projectId = classification.projectId ?? run.projectId;
  const worktreeId = classification.worktreeId ?? run.worktreeId;
  const sessionId = classification.sessionId ?? run.sessionId;
  const providerData = classification.providerData ?? run.providerData;
  if (projectId !== undefined) nextRun.projectId = projectId;
  if (worktreeId !== undefined) nextRun.worktreeId = worktreeId;
  if (sessionId !== undefined) nextRun.sessionId = sessionId;
  if (run.pid !== undefined) nextRun.pid = run.pid;
  if (run.cwd !== undefined) nextRun.cwd = run.cwd;
  if (providerData !== undefined) nextRun.providerData = providerData;
  return {
    run: nextRun,
    status: classification.status,
  };
}
