import type {
  ClientFeatureFlags,
  HarnessRunObservation,
  ProviderHealth,
  ProviderProjectConfig,
  SafeError,
  StationSnapshot,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { durationMs, toIsoTimestamp } from "@station/runtime";
import type {
  EventJournal,
  ObservationStore,
  PersistedWorktreeDisplayTitle,
  ReconcileStore,
  SessionGroupStore,
  SessionStore,
  WorktreeMetadataStore,
} from "../persistence/index.js";
import { providerObservationRetentionDays } from "../persistence/retention.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveWorktreeDisplayTitle } from "../worktreeDisplayTitle.js";
import { buildStationSnapshot } from "./graph.js";
import {
  harnessRunsWithPersistedEventStatus,
  repairPersistedHarnessEventCompatibility,
} from "./harnessEventRepair.js";
import { decayStaleBusyStatuses, type ObserverHarnessRun } from "./harnessEventStatus.js";
import {
  normalizeHarnessRunsForCurrentWorktrees,
  normalizeTerminalTargetsForCurrentWorktrees,
  reattachSessionTitleEvidence,
} from "./observationCorrelation.js";
import {
  type ProviderReadOptions,
  readHarnessObservations,
  readRepositoryProviderHealth,
  readTerminalTargetObservations,
  readWorktreeObservations,
} from "./providerObservations.js";
import type { ReconcileTiming } from "./reconcileResult.js";
import { reconcileSessionGroups } from "./sessionGroups.js";
import { harnessesFromRegistry } from "./snapshotSeed.js";
import { worktreesWithCachedMetadata } from "./worktreeMetadataOverlay.js";

type ReconcileOnceInput = {
  reason: string;
  observer: {
    pid: number;
    startedAt: string;
    version: string;
  };
  projects: ProviderProjectConfig[];
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  persistence?: ObservationStore &
    ReconcileStore &
    SessionStore &
    SessionGroupStore &
    WorktreeMetadataStore &
    EventJournal;
  providerObservationRetentionDays?: number;
  featureFlags?: ClientFeatureFlags;
};

type ReconcileOnceResult = {
  snapshot: StationSnapshot;
  providerHealth: Record<string, ProviderHealth>;
  lastReconcile: ReconcileTiming;
};

/**
 * USE CASE
 *
 * Orchestrates provider reads, relationship correlation, durable harness-event repair and overlays,
 * cached metadata hydration, Group projection, snapshot assembly, and atomic persistence in order.
 * The same resolved title records feed snapshot composition and atomic reconcile persistence.
 */
export async function runReconcileOnce(input: ReconcileOnceInput): Promise<ReconcileOnceResult> {
  const started = toIsoTimestamp(input.read.clock.now());
  const retentionDays =
    input.providerObservationRetentionDays ?? providerObservationRetentionDays();
  await input.read.logger?.info("Reconcile started.", { reason: input.reason });
  if (input.persistence !== undefined) {
    await repairPersistedHarnessEventCompatibility({
      persistence: input.persistence,
      providers: input.providers,
      now: started,
    });
    await input.persistence.pruneExpiredProviderObservations(started);
  }
  const errors: SafeError[] = [];
  const providerHealth: Record<string, ProviderHealth> = {};

  // Worktree and terminal reads are independent of each other.
  const [worktreeResult, terminalResult] = await Promise.all([
    readWorktreeObservations({
      providers: input.providers,
      projects: input.projects,
      read: input.read,
      providerHealth,
      errors,
    }),
    readTerminalTargetObservations({
      providers: input.providers,
      read: input.read,
      providerHealth,
      errors,
    }),
  ]);
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
  readRepositoryProviderHealth({
    providers: input.providers,
    read: input.read,
    providerHealth,
  });

  const finishedAt = toIsoTimestamp(input.read.clock.now());
  const harnessStatusInput: {
    persistence?: ObservationStore & SessionStore;
    providers: ProviderRegistry;
    harnessRuns: ObserverHarnessRun[];
    now: string;
  } = {
    providers: input.providers,
    harnessRuns: harnessResult.harnessRuns,
    now: finishedAt,
  };
  if (input.persistence !== undefined) {
    harnessStatusInput.persistence = input.persistence;
  }
  const harnessRunsWithStatus = decayStaleBusyStatuses({
    runs: await harnessRunsWithPersistedEventStatus(harnessStatusInput),
    now: finishedAt,
  });
  const harnessRuns = normalizeHarnessRunsForCurrentWorktrees({
    harnessRuns: harnessRunsWithStatus,
    worktrees: worktreeResult.worktrees,
    terminalTargets,
  });
  const metadataInput: {
    persistence?: WorktreeMetadataStore;
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
  const [sessionMetadata, persistedWorktreeDisplayTitles, recoveryHandles, turnReadiness] =
    input.persistence === undefined
      ? [[], [], [], []]
      : await Promise.all([
          input.persistence.listSessions(),
          input.persistence.listWorktreeDisplayTitles(),
          input.persistence.listSessionRecoveryHandles(),
          input.persistence.listSessionTurnReadiness(),
        ]);
  const configuredProjectIds = new Set(input.projects.map((project) => project.id));
  const titleSessionEvidence = reattachSessionTitleEvidence({
    sessions: sessionMetadata,
    harnessRuns,
    terminalTargets,
  });
  const worktreeDisplayTitles: PersistedWorktreeDisplayTitle[] = worktreesForSnapshot
    .filter(
      (worktree) => worktree.state === "exists" && configuredProjectIds.has(worktree.projectId),
    )
    .map((worktree) => {
      const existing = persistedWorktreeDisplayTitles.find(
        (title) => title.projectId === worktree.projectId && title.worktreeId === worktree.id,
      );
      if (existing !== undefined) return existing;
      return {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        title: resolveWorktreeDisplayTitle({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          branch: worktree.branch,
          canonicalTitles: persistedWorktreeDisplayTitles,
          sessions: titleSessionEvidence,
        }),
        createdAt: finishedAt,
        updatedAt: finishedAt,
      };
    });
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
  const baseSnapshot = buildStationSnapshot({
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
    worktreeDisplayTitles,
    recoveryHandles,
    turnReadiness,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
  });
  const groupProjection = await reconcileSessionGroups({
    ...(input.persistence === undefined ? {} : { store: input.persistence }),
    projects: input.projects,
    sessions: baseSnapshot.sessions,
    updatedAt: finishedAt,
  });
  errors.push(...groupProjection.errors);
  const snapshot: StationSnapshot = {
    ...baseSnapshot,
    sessionGroups: groupProjection.sessionGroups,
  };

  lastReconcile.eventsEmitted = await persistReconcileResult({
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    projects: input.projects,
    worktrees: worktreeResult.worktrees,
    terminalTargets,
    harnessRuns: harnessRuns.map((harnessRun) => harnessRun.run),
    worktreeDisplayTitles,
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

async function persistReconcileResult(input: {
  persistence?: ReconcileStore & EventJournal;
  projects: ProviderProjectConfig[];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  worktreeDisplayTitles: PersistedWorktreeDisplayTitle[];
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
    worktreeDisplayTitles: input.worktreeDisplayTitles,
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
