import type {
  ClientFeatureFlags,
  HarnessCapabilities,
  HarnessEventObservation,
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
import {
  durationMs,
  forEachConcurrent,
  pathIsSameOrInside,
  publicSafeErrorFromUnknown,
  type RuntimeClock,
  runRuntimeBoundaryWithRetryAndTimeout,
  toIsoTimestamp,
} from "@station/runtime";
import {
  bindHarnessRunsToSessionExecutions,
  decideSessionHarnessExecution,
  sessionHarnessExecutionEvidenceFromObservation,
} from "../harnessExecutionIdentity.js";
import { sessionTurnReadinessMutationFromHarnessObservation } from "../hooks/turnReadiness.js";
import { staleChangeSummary, staleChecks, stalePullRequest } from "../metadata/stalePayloads.js";
import type {
  EventJournal,
  ObservationStore,
  PersistedProviderObservation,
  PersistedSessionHarnessExecution,
  PersistedSessionTurnReadiness,
  ReconcileStore,
  SessionHarnessDerivedStateRepair,
  SessionStore,
  WorktreeMetadataStore,
} from "../persistence/index.js";
import { providerObservationRetentionDays } from "../persistence/retention.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StationLogger } from "../stationLogger.js";
import type { ReconcileTiming } from "./core.js";
import { buildStationSnapshot, safeErrorToProviderHealth } from "./graph.js";
import {
  applyHarnessEventStatusOverlays,
  decayStaleBusyStatuses,
  type ObserverHarnessRun,
  synthesizeExternalHarnessRuns,
} from "./harnessEventStatus.js";

export type ProviderReadOptions = {
  clock: RuntimeClock;
  timeoutMs: number;
  retries: number;
  logger?: StationLogger;
};

// Caps concurrent provider subprocesses (wt list / listTargets) per reconcile.
const providerReadConcurrency = 4;

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
  persistence?: ObservationStore &
    ReconcileStore &
    SessionStore &
    WorktreeMetadataStore &
    EventJournal;
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

/**
 * USE CASE
 *
 * Rebuilds the Observer graph from provider reads and accepted durable evidence.
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

  input.providerHealth[provider.id] = cachedProviderHealth({
    providers: input.providers,
    providerId: provider.id,
    providerType: "worktree",
    capabilities,
    clock: input.read.clock,
  });

  // Indexed collection keeps worktree order deterministic (config project order)
  // while listWorktrees calls run concurrently.
  const worktreesByProject: WorktreeObservation[][] = input.projects.map(() => []);
  let projectsScanned = 0;
  // One provider-level failure stops the remaining project scans: a hung
  // provider would otherwise burn its full timeout budget once per project.
  let providerFailed = false;
  await forEachConcurrent(
    input.projects,
    { concurrency: providerReadConcurrency },
    async (project, index) => {
      if (providerFailed) {
        return;
      }
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
        providerFailed = true;
        await recordProviderReadFailure({
          providers: input.providers,
          providerId: provider.id,
          providerType: "worktree",
          message: "Worktree provider list failed.",
          error: result.error,
          timing: result.timing,
          capabilities,
          providerHealth: input.providerHealth,
          errors: input.errors,
          logger: input.read.logger,
        });
        return;
      }

      projectsScanned += 1;
      worktreesByProject[index] = result.value;
    },
  );

  return { worktrees: worktreesByProject.flat(), projectsScanned };
}

async function readTerminalTargetObservations(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
}): Promise<{
  terminalTargets: TerminalTargetObservation[];
}> {
  const providers = Array.from(input.providers.terminals.values());
  // Indexed collection keeps target order deterministic (provider registration
  // order) while listTargets calls run concurrently.
  const targetsByProvider: TerminalTargetObservation[][] = providers.map(() => []);

  await forEachConcurrent(
    providers,
    { concurrency: providerReadConcurrency },
    async (provider, index) => {
      const capabilities = provider.capabilities();

      input.providerHealth[provider.id] = cachedProviderHealth({
        providers: input.providers,
        providerId: provider.id,
        providerType: "terminal",
        capabilities,
        clock: input.read.clock,
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
        targetsByProvider[index] = result.value;
      } else {
        await recordProviderReadFailure({
          providers: input.providers,
          providerId: provider.id,
          providerType: "terminal",
          message: "Terminal provider list failed.",
          error: result.error,
          timing: result.timing,
          capabilities,
          providerHealth: input.providerHealth,
          errors: input.errors,
          logger: input.read.logger,
        });
      }
    },
  );

  return { terminalTargets: targetsByProvider.flat() };
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
    input.providerHealth[provider.id] = cachedProviderHealth({
      providers: input.providers,
      providerId: provider.id,
      providerType: "harness",
      capabilities,
      clock: input.read.clock,
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
        providers: input.providers,
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

    await recordProviderReadFailure({
      providers: input.providers,
      providerId: provider.id,
      providerType: "harness",
      message: "Harness provider discovery failed.",
      error: result.error,
      timing: result.timing,
      capabilities,
      providerHealth: input.providerHealth,
      errors: input.errors,
      logger: input.read.logger,
    });
  }

  return { harnessRuns, harnessCapabilities };
}

function readRepositoryProviderHealth(input: {
  providers: ProviderRegistry;
  read: ProviderReadOptions;
  providerHealth: Record<string, ProviderHealth>;
}): void {
  for (const provider of input.providers.repositories.values()) {
    input.providerHealth[provider.id] = cachedProviderHealth({
      providers: input.providers,
      providerId: provider.id,
      providerType: "repository",
      capabilities: provider.capabilities(),
      clock: input.read.clock,
    });
  }
}

async function classifyHarnessRuns(input: {
  providers: ProviderRegistry;
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

    await recordProviderReadFailure({
      providers: input.providers,
      providerId: input.provider.id,
      providerType: "harness",
      message: "Harness provider classification failed.",
      error: classification.error,
      timing: classification.timing,
      capabilities: input.capabilities,
      providerHealth: input.providerHealth,
      errors: input.errors,
      logger: input.read.logger,
    });
  }

  return classifiedRuns;
}

async function harnessRunsWithPersistedEventStatus(input: {
  persistence?: ObservationStore & SessionStore;
  providers: ProviderRegistry;
  harnessRuns: ObserverHarnessRun[];
  now: string;
}): Promise<ObserverHarnessRun[]> {
  if (input.persistence === undefined) {
    return input.harnessRuns;
  }

  const persisted = await input.persistence.listProviderObservations({
    entityKind: "harness_event",
    now: input.now,
  });
  const { observations } = admitPersistedHarnessEvents(input.providers, persisted);
  const bindings = await input.persistence.listSessionHarnessExecutions();
  const boundRuns = bindHarnessRunsToSessionExecutions({
    runs: input.harnessRuns.map((run) => run.run),
    bindings,
  });
  const runsWithBindings = input.harnessRuns.map((run, index) => ({
    ...run,
    run: boundRuns[index] ?? run.run,
  }));
  return applyHarnessEventStatusOverlays({
    runs: synthesizeExternalHarnessRuns({ runs: runsWithBindings, observations }),
    observations,
  });
}

async function repairPersistedHarnessEventCompatibility(input: {
  persistence: ObservationStore & SessionStore;
  providers: ProviderRegistry;
  now: string;
}): Promise<void> {
  const [persisted, bindings, readiness] = await Promise.all([
    input.persistence.listProviderObservations({
      entityKind: "harness_event",
      includeExpired: true,
      now: input.now,
    }),
    input.persistence.listSessionHarnessExecutions(),
    input.persistence.listSessionTurnReadiness(),
  ]);
  const { observations, rejectedBySession } = admitPersistedHarnessEvents(
    input.providers,
    persisted,
  );
  const currentObservations = observations.filter((observation) => !observation.expired);
  for (const rejected of rejectedBySession.values()) {
    const currentBinding = bindings.find(
      (binding) =>
        binding.provider === rejected.provider && binding.sessionId === rejected.sessionId,
    );
    const currentReadiness = readiness.find(
      (candidate) => candidate.sessionId === rejected.sessionId,
    );
    if (
      derivedStateSupersedesRejectedEvent({
        binding: currentBinding,
        readiness: currentReadiness,
        rejectedAt: rejected.latestStatusUpdatedAt,
      })
    ) {
      continue;
    }
    const replay = replayAcceptedSessionState({
      observations: currentObservations,
      provider: rejected.provider,
      sessionId: rejected.sessionId,
    });
    const repair: SessionHarnessDerivedStateRepair = {
      provider: rejected.provider,
      sessionId: rejected.sessionId,
    };
    if (replay.harnessExecution !== undefined) {
      repair.harnessExecution = replay.harnessExecution;
    }
    if (replay.turnReadiness !== undefined) {
      repair.turnReadiness = replay.turnReadiness;
    }
    await input.persistence.repairSessionHarnessDerivedState(repair);
  }
}

type RejectedPersistedSession = {
  provider: string;
  sessionId: string;
  latestStatusUpdatedAt: string;
};

function admitPersistedHarnessEvents(
  providers: ProviderRegistry,
  observations: PersistedProviderObservation[],
): {
  observations: PersistedProviderObservation[];
  rejectedBySession: Map<string, RejectedPersistedSession>;
} {
  const accepted: PersistedProviderObservation[] = [];
  const rejectedBySession = new Map<string, RejectedPersistedSession>();
  for (const observation of observations) {
    if (observation.entityKind !== "harness_event") continue;
    const provider = providers.harnesses.get(observation.provider);
    if (provider?.acceptsPersistedEvent?.(observation.payload) !== false) {
      accepted.push(observation);
      continue;
    }
    const sessionId = observation.payload.sessionId;
    if (sessionId === undefined) continue;
    const key = `${observation.provider}\u0000${sessionId}`;
    const latestStatusUpdatedAt = observation.payload.status?.updatedAt ?? observation.observedAt;
    const current = rejectedBySession.get(key);
    if (
      current === undefined ||
      Date.parse(latestStatusUpdatedAt) >= Date.parse(current.latestStatusUpdatedAt)
    ) {
      rejectedBySession.set(key, {
        provider: observation.provider,
        sessionId,
        latestStatusUpdatedAt,
      });
    }
  }
  return { observations: accepted, rejectedBySession };
}

function derivedStateSupersedesRejectedEvent(input: {
  binding: PersistedSessionHarnessExecution | undefined;
  readiness: PersistedSessionTurnReadiness | undefined;
  rejectedAt: string;
}): boolean {
  const rejectedAt = Date.parse(input.rejectedAt);
  if (!Number.isFinite(rejectedAt)) return false;
  return [input.binding?.statusUpdatedAt, input.readiness?.completedAt].some((value) => {
    if (value === undefined) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > rejectedAt;
  });
}

function replayAcceptedSessionState(input: {
  observations: PersistedProviderObservation[];
  provider: string;
  sessionId: string;
}): {
  harnessExecution?: PersistedSessionHarnessExecution;
  turnReadiness?: PersistedSessionTurnReadiness;
} {
  let harnessExecution: PersistedSessionHarnessExecution | undefined;
  let turnReadiness: PersistedSessionTurnReadiness | undefined;
  for (const observation of input.observations) {
    if (
      observation.entityKind !== "harness_event" ||
      observation.provider !== input.provider ||
      observation.payload.sessionId !== input.sessionId
    ) {
      continue;
    }
    const event: HarnessEventObservation = observation.payload;
    const decision = decideSessionHarnessExecution({
      current: harnessExecution,
      evidence: sessionHarnessExecutionEvidenceFromObservation(event),
    });
    if (decision.binding !== undefined) {
      harnessExecution = decision.binding;
    }
    if (!decision.mayDeriveState) continue;
    const mutation = sessionTurnReadinessMutationFromHarnessObservation({
      observation: event,
      updatedAt: observation.observedAt,
    });
    if (mutation?.action === "upsert") {
      turnReadiness = {
        ...mutation.value,
        createdAt: observation.observedAt,
      };
    } else if (mutation?.action === "delete") {
      turnReadiness = undefined;
    }
  }
  const replay: {
    harnessExecution?: PersistedSessionHarnessExecution;
    turnReadiness?: PersistedSessionTurnReadiness;
  } = {};
  if (harnessExecution !== undefined) replay.harnessExecution = harnessExecution;
  if (turnReadiness !== undefined) replay.turnReadiness = turnReadiness;
  return replay;
}

async function persistReconcileResult(input: {
  persistence?: ReconcileStore & EventJournal;
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

// Reconcile never awaits a health probe: it reads the out-of-band cache and
// reports "unknown" until the first probe lands.
function cachedProviderHealth(input: {
  providers: ProviderRegistry;
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  capabilities: Record<string, boolean>;
  clock: RuntimeClock;
}): ProviderHealth {
  const cached = input.providers.healthCache.read(input.providerId);
  if (cached !== undefined) {
    return cached;
  }
  return {
    providerId: input.providerId,
    providerType: input.providerType,
    status: "unknown",
    lastCheckedAt: toIsoTimestamp(input.clock.now()),
    capabilities: input.capabilities,
  };
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

async function recordProviderReadFailure(input: {
  providers: ProviderRegistry;
  providerId: ProviderId;
  providerType: ProviderHealth["providerType"];
  message: string;
  error: SafeError;
  timing: { finishedAt: string; durationMs: number };
  capabilities: Record<string, boolean>;
  providerHealth: Record<string, ProviderHealth>;
  errors: SafeError[];
  logger: StationLogger | undefined;
}): Promise<void> {
  input.errors.push(
    publicSafeErrorFromUnknown(input.error, {
      tag: input.error.tag,
      code: input.error.code,
      message: input.error.message,
      provider: input.providerId,
    }),
  );
  await input.logger?.error(input.message, {
    provider: input.providerId,
    error: input.error,
    durationMs: input.timing.durationMs,
  });
  input.providerHealth[input.providerId] = failedProviderHealth({
    providerId: input.providerId,
    providerType: input.providerType,
    lastCheckedAt: input.timing.finishedAt,
    lastError: input.error,
    latencyMs: input.timing.durationMs,
    capabilities: input.capabilities,
  });
  // Re-probe only when the cache still says healthy; a fresh cached failure
  // needs no confirmation, and read() already schedules stale refreshes.
  if (input.providers.healthCache.read(input.providerId)?.status === "healthy") {
    void input.providers.healthCache.refresh(input.providerId);
  }
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
    lastError: publicSafeErrorFromUnknown(input.lastError, {
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
  if (run.nativeSessionId !== undefined) nextRun.nativeSessionId = run.nativeSessionId;
  if (run.pid !== undefined) nextRun.pid = run.pid;
  if (run.cwd !== undefined) nextRun.cwd = run.cwd;
  if (providerData !== undefined) nextRun.providerData = providerData;
  return {
    run: nextRun,
    status: classification.status,
  };
}
