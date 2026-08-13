import type {
  HarnessCapabilities,
  HarnessRunObservation,
  ProviderHealth,
  ProviderProjectConfig,
  SafeError,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { toIsoTimestamp } from "@station/runtime";
import type {
  ObservationStore,
  SessionStore,
  WorktreeMetadataStore,
} from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import { harnessRunsWithPersistedEventStatus } from "../harnessEventRepair.js";
import { decayStaleBusyStatuses } from "../harnessEventStatus.js";
import {
  normalizeHarnessRunsForCurrentWorktrees,
  normalizeTerminalTargetsForCurrentWorktrees,
} from "../observationCorrelation.js";
import {
  type ProviderReadOptions,
  readHarnessObservations,
  readRepositoryProviderHealth,
  readTerminalTargetObservations,
  readWorktreeObservations,
} from "../providerObservations.js";
import { worktreesWithCachedMetadata } from "../worktreeMetadataOverlay.js";

type ReconcileObservationPersistence = ObservationStore & SessionStore & WorktreeMetadataStore;

export type CurrentReconcileObservations = {
  observedAt: string;
  worktrees: WorktreeObservation[];
  projectsScanned: number;
  terminalTargets: TerminalTargetObservation[];
  terminalTargetsRead: number;
  harnessRuns: HarnessRunObservation[];
  harnessCapabilities: Record<string, HarnessCapabilities>;
  worktreesForSnapshot: WorktreeObservation[];
};

/**
 * Reads and overlays current reconcile observations, preserving provider-read concurrency and phase order.
 */
export async function readCurrentReconcileObservations(input: {
  providers: ProviderRegistry;
  projects: ProviderProjectConfig[];
  read: ProviderReadOptions;
  persistence?: ReconcileObservationPersistence;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<CurrentReconcileObservations> {
  // Worktree and terminal reads remain independent; correlation follows both reads.
  const [worktreeResult, terminalResult] = await Promise.all([
    readWorktreeObservations({
      providers: input.providers,
      projects: input.projects,
      read: input.read,
      providerHealth: input.providerHealth,
      errors: input.errors,
    }),
    readTerminalTargetObservations({
      providers: input.providers,
      read: input.read,
      providerHealth: input.providerHealth,
      errors: input.errors,
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
    providerHealth: input.providerHealth,
    errors: input.errors,
  });
  readRepositoryProviderHealth({
    providers: input.providers,
    read: input.read,
    providerHealth: input.providerHealth,
  });

  const observedAt = toIsoTimestamp(input.read.clock.now());
  const harnessStatusInput: {
    persistence?: ObservationStore & SessionStore;
    providers: ProviderRegistry;
    harnessRuns: HarnessRunObservation[];
    now: string;
  } = {
    providers: input.providers,
    harnessRuns: harnessResult.harnessRuns,
    now: observedAt,
  };
  if (input.persistence !== undefined) {
    harnessStatusInput.persistence = input.persistence;
  }
  const harnessRunsWithStatus = decayStaleBusyStatuses({
    runs: await harnessRunsWithPersistedEventStatus(harnessStatusInput),
    now: observedAt,
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
    now: observedAt,
  };
  if (input.persistence !== undefined) {
    metadataInput.persistence = input.persistence;
  }
  const worktreesForSnapshot = await worktreesWithCachedMetadata(metadataInput);

  return {
    observedAt,
    worktrees: worktreeResult.worktrees,
    projectsScanned: worktreeResult.projectsScanned,
    terminalTargets,
    terminalTargetsRead: terminalResult.terminalTargets.length,
    harnessRuns,
    harnessCapabilities: harnessResult.harnessCapabilities,
    worktreesForSnapshot,
  };
}
