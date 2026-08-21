import type {
  ClientFeatureFlags,
  HarnessRunObservation,
  ProviderHealth,
  ProviderId,
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
import { buildStationSnapshot } from "./graph.js";
import { repairPersistedHarnessEventCompatibility } from "./harnessEventRepair.js";
import type { ProviderReadOptions } from "./providerObservations.js";
import type { ReconcileTiming } from "./reconcileResult.js";
import {
  type CurrentReconcileObservations,
  readCurrentReconcileObservations,
} from "./run/currentObservations.js";
import { type ReconcileSnapshotInputs, readReconcileSnapshotInputs } from "./run/snapshotInputs.js";
import { reconcileSessionGroups } from "./sessionGroups.js";
import { harnessesFromRegistry } from "./snapshotSeed.js";

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
  terminalTargets: TerminalTargetObservation[];
  providerHealth: Record<string, ProviderHealth>;
  lastReconcile: ReconcileTiming;
};

/**
 * USE CASE
 *
 * Orchestrates provider reads, relationship correlation, durable harness-event repair and overlays,
 * cached metadata hydration, Group projection, snapshot and sanitized-debug input assembly, and
 * atomic session persistence. The same resolved title and terminal records feed every output.
 */
export async function runReconcileOnce(input: ReconcileOnceInput): Promise<ReconcileOnceResult> {
  const started = toIsoTimestamp(input.read.clock.now());
  const retentionDays =
    input.providerObservationRetentionDays ?? providerObservationRetentionDays();
  await input.read.logger?.info("Reconcile started.", { reason: input.reason });

  // Compatibility repair must precede current provider state assembly.
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

  // Provider reads, relationship correlation, durable status, and cached metadata stay ordered here.
  const observations = await readCurrentReconcileObservations({
    providers: input.providers,
    projects: input.projects,
    read: input.read,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    providerHealth,
    errors,
  });
  const finishedAt = observations.observedAt;

  // Snapshot records are loaded after current identities so title evidence is reattached correctly.
  const snapshotInputs = await readReconcileSnapshotInputs({
    projects: input.projects,
    worktrees: observations.worktreesForSnapshot,
    harnessRuns: observations.harnessRuns,
    terminalTargets: observations.terminalTargets,
    now: finishedAt,
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
  });
  const lastReconcile: ReconcileTiming = {
    reason: input.reason,
    startedAt: started,
    finishedAt,
    durationMs: durationMs(started, finishedAt),
    projectsScanned: observations.projectsScanned,
    worktreesObserved: observations.worktrees.length,
    terminalTargetsObserved: observations.terminalTargets.length,
    harnessRunsObserved: observations.harnessRuns.length,
    eventsEmitted: 0,
    errors,
  };

  // Graph assembly and atomic persistence consume the same correlated records.
  const snapshot = await buildReconcileSnapshot({
    observer: input.observer,
    projects: input.projects,
    worktreeProviderId: input.providers.worktree.id,
    providerHealth,
    harnesses: harnessesFromRegistry(input.providers),
    harnessCapabilities: observations.harnessCapabilities,
    worktrees: observations.worktreesForSnapshot,
    terminalTargets: observations.terminalTargets,
    harnessRuns: observations.harnessRuns,
    snapshotInputs,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    generatedAt: finishedAt,
    errors,
  });

  lastReconcile.eventsEmitted = await persistReconcileResult({
    ...(input.persistence === undefined ? {} : { persistence: input.persistence }),
    worktrees: observations.worktrees,
    terminalTargets: observations.terminalTargets,
    harnessRuns: observations.harnessRuns,
    worktreeDisplayTitles: snapshotInputs.worktreeDisplayTitles,
    providerHealth,
    observedAt: finishedAt,
    providerObservationRetentionDays: retentionDays,
  });

  await input.read.logger?.info("Reconcile finished.", {
    reason: input.reason,
    durationMs: lastReconcile.durationMs,
    projectsScanned: observations.projectsScanned,
    worktreesObserved: observations.worktrees.length,
    terminalTargetsObserved: observations.terminalTargetsRead,
    harnessRunsObserved: observations.harnessRuns.length,
    errorCount: errors.length,
  });

  return {
    snapshot,
    terminalTargets: observations.terminalTargets,
    providerHealth,
    lastReconcile,
  };
}

/**
 * Builds the graph and applies durable Group repair from the same correlated records used for persistence.
 */
async function buildReconcileSnapshot(input: {
  generatedAt: string;
  observer: ReconcileOnceInput["observer"];
  projects: ProviderProjectConfig[];
  worktreeProviderId: ProviderId;
  providerHealth: Record<string, ProviderHealth>;
  harnesses: ReturnType<typeof harnessesFromRegistry>;
  harnessCapabilities: CurrentReconcileObservations["harnessCapabilities"];
  worktrees: WorktreeObservation[];
  terminalTargets: TerminalTargetObservation[];
  harnessRuns: HarnessRunObservation[];
  snapshotInputs: ReconcileSnapshotInputs;
  featureFlags?: ClientFeatureFlags;
  persistence?: SessionGroupStore;
  errors: SafeError[];
}): Promise<StationSnapshot> {
  const baseSnapshot = buildStationSnapshot({
    generatedAt: input.generatedAt,
    observer: input.observer,
    projects: input.projects,
    worktreeProviderId: input.worktreeProviderId,
    providerHealth: input.providerHealth,
    harnesses: input.harnesses,
    harnessCapabilities: input.harnessCapabilities,
    worktrees: input.worktrees,
    terminalTargets: input.terminalTargets,
    harnessRuns: input.harnessRuns,
    sessionMetadata: input.snapshotInputs.sessionMetadata,
    worktreeDisplayTitles: input.snapshotInputs.worktreeDisplayTitles,
    recoveryHandles: input.snapshotInputs.recoveryHandles,
    turnReadiness: input.snapshotInputs.turnReadiness,
    ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
  });
  const groupProjection = await reconcileSessionGroups({
    ...(input.persistence === undefined ? {} : { store: input.persistence }),
    projects: input.projects,
    sessions: baseSnapshot.sessions,
    updatedAt: input.generatedAt,
  });
  input.errors.push(...groupProjection.errors);
  return {
    ...baseSnapshot,
    sessionGroups: groupProjection.sessionGroups,
  };
}

async function persistReconcileResult(input: {
  persistence?: ReconcileStore & EventJournal;
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
