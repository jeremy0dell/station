import { type ConfigDiagnostic, emptyConfig, type StationConfig } from "@station/config";
import type {
  CommandId,
  CommandRecord,
  DiagnosticCollectionOptions,
  DiagnosticSnapshot,
  DoctorOptions,
  DoctorReport,
  EventFilter,
  HarnessEventReport,
  HarnessEventReportReceipt,
  ObserverApi,
  ObserverHealth,
  ObserverStopReceipt,
  ProviderHealth,
  ProviderHookEvent,
  ProviderHookReceipt,
  ReconcileReceipt,
  SessionRecoveryReadiness,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import { STARTUP_RECONCILE_REASONS, STATION_SCHEMA_VERSION } from "@station/contracts";
import { createTraceContext } from "@station/observability";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { resolveWorktreeRowOrThrow } from "../commands/cleanup/index.js";
import type { CommandQueue } from "../commands/queue.js";
import { commandRecordFromPersisted } from "../commands/record.js";
import { validateWorktreeRemoval } from "../commands/worktree/removalValidation.js";
import {
  collectDiagnosticSnapshot,
  type ObserverDiagnosticsDeps,
  runDoctor,
} from "../diagnostics/collector.js";
import type { DiagnosticEvidenceSource } from "../diagnostics/evidenceSource.js";
import {
  createHarnessIngressQueue,
  type HarnessIngressQueue,
} from "../hooks/harnessIngressQueue.js";
import {
  createHarnessEventReportIngestion,
  createProviderHookIngress,
  type HarnessEventReportIngestion,
  type ProviderHookIngress,
} from "../hooks/ingestion.js";
import {
  createFilesystemProviderIngressSpoolStore,
  providerIngressSpoolDepth,
} from "../hooks/spool.js";
import { createLocalGitWorktreeMetadataInvalidationSource } from "../metadata/gitRefInvalidation.js";
import { createLocalGitWorktreeChangeSource } from "../metadata/localGitChangeSummary.js";
import type { ResolveLocalGitMetadataWorktree } from "../metadata/localGitWorktree.js";
import type {
  WorktreeChangeSource,
  WorktreeMetadataInvalidationSource,
} from "../metadata/ports.js";
import {
  createWorktreeMetadataRefreshService,
  type WorktreeMetadataRefreshService,
} from "../metadata/refresh.js";
import type { ObserverPersistenceBundle, PersistenceHealthSource } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { type ObserverCore, providerProjectsFromConfig } from "../reconcile/core.js";
import type { StationLogger } from "../stationLogger.js";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../worktreeMutationCoordinator.js";
import type { ObserverEventBus } from "./eventBus.js";
import {
  type ExternalLaunchDeps,
  prepareExternalLaunch,
  reportExternalExit,
} from "./externalLaunch.js";
import type { HarnessReportProcessorDeps } from "./harnessReportProcessor.js";
import { processHarnessIngressReport } from "./harnessReportProcessor.js";
import type { ObserverReapPlan } from "./observerReap.js";
import { type ReconcileExecutorDeps, runReconcile } from "./reconcileExecutor.js";
import { logReconcileSchedulerProfile } from "./reconcileProfiling.js";
import {
  type CreateReconcileSchedulerOptions,
  createReconcileScheduler,
} from "./reconcileScheduler.js";
import { createSpoolDrainer, type SpoolDrainDeps } from "./spoolDrain.js";

export type CreateObserverApiOptions = {
  core: ObserverCore;
  providers?: ProviderRegistry;
  persistence: ObserverPersistenceBundle;
  persistenceHealth: PersistenceHealthSource;
  commandQueue: CommandQueue;
  worktreeMutations?: WorktreeMutationCoordinator;
  eventBus: ObserverEventBus;
  diagnosticEvidenceSource: DiagnosticEvidenceSource;
  clock?: RuntimeClock;
  providerHookIngress?: ProviderHookIngress;
  harnessEventReportIngestion?: HarnessEventReportIngestion;
  harnessIngressQueue?: HarnessIngressQueue;
  hookSpoolDir?: string;
  socketPath?: string;
  /** Exact handoff selector; legacy callers fall back to the core snapshot version. */
  observerBuildVersion?: string;
  stateDir?: string;
  logger?: StationLogger;
  config?: StationConfig;
  configPath?: string;
  configDiagnostics?: ConfigDiagnostic[];
  metadataRefresh?: WorktreeMetadataRefreshService;
  worktreeChangeSource?: WorktreeChangeSource;
  worktreeMetadataInvalidationSource?: WorktreeMetadataInvalidationSource;
  onShutdownStarted?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  hookReconcileDebounceMs?: number;
  duplicateInspection?: () => Promise<ObserverReapPlan> | undefined;
};

/**
 * COMPOSITION ROOT
 *
 * Wires Observer use cases with supplied durable, local-metadata, and diagnostic-
 * evidence roles, ingress workers, provider-health publication, scheduling, exact
 * build publication, recovery-readiness queries, read-only singleton diagnostics,
 * and adapter shutdown behind the application API.
 */
export function createObserverApi(options: CreateObserverApiOptions): ObserverApi {
  const clock = options.clock ?? systemClock;
  const worktreeMutations = options.worktreeMutations ?? createWorktreeMutationCoordinator();
  const reconciling = { reconciling: false };
  const providerHealthCache = options.providers?.healthCache;
  const pendingProviderHealthPublications = new Set<Promise<void>>();
  let acceptingProviderHealthPublications = true;

  const publishProviderHealthProbe = async (health: ProviderHealth): Promise<void> => {
    try {
      const event = await options.core.commitProviderHealthProbe(health);
      if (event !== undefined) {
        options.eventBus.publish(event);
      }
    } catch (error) {
      await options.logger
        ?.error("Completed provider health probe could not be published.", {
          provider: health.providerId,
          error,
        })
        .catch(() => undefined);
    }
  };

  const unsubscribeProviderHealth = providerHealthCache?.onProbeCompleted((health) => {
    if (!acceptingProviderHealthPublications) {
      return;
    }
    const publication = publishProviderHealthProbe(health);
    pendingProviderHealthPublications.add(publication);
    void publication.finally(() => pendingProviderHealthPublications.delete(publication));
    return publication;
  });
  const stopProviderHealthPublication = async (): Promise<void> => {
    acceptingProviderHealthPublications = false;
    unsubscribeProviderHealth?.();
    await Promise.all(pendingProviderHealthPublications);
  };

  // Assigned after metadataRefresh + the drainer (which need the scheduler); the
  // scheduler/launch closures only read it once a reconcile actually runs.
  let reconcileDeps: ReconcileExecutorDeps;

  const schedulerOptions: CreateReconcileSchedulerOptions = {
    reconcile: (reason) => runReconcile(reconcileDeps, reconciling, reason),
  };
  if (options.hookReconcileDebounceMs !== undefined) {
    schedulerOptions.debounceMs = options.hookReconcileDebounceMs;
  }
  if (options.logger !== undefined) {
    schedulerOptions.onError = async (error) => {
      await options.logger?.error("Scheduled observer reconcile failed.", { error });
    };
    schedulerOptions.onFlushFinish = async (profile) => {
      await logReconcileSchedulerProfile(options.logger, profile);
    };
  }
  const reconcileScheduler = createReconcileScheduler(schedulerOptions);
  const metadataRefresh = buildMetadataRefresh(options, clock, reconcileScheduler);
  // The ingress needs the harness report queue for adapter-normalized events,
  // but the queue is built after it — resolve through a late-bound reference.
  let harnessIngressQueueRef: HarnessIngressQueue | undefined;
  const providerHookIngress = buildProviderHookIngress(
    options,
    clock,
    reconcileScheduler,
    async (report) => {
      if (harnessIngressQueueRef === undefined) {
        throw new Error("Harness ingress queue is not initialized.");
      }
      return harnessIngressQueueRef.enqueue(report);
    },
  );
  const harnessEventReportIngestion = buildHarnessEventReportIngestion(options, clock);

  const harnessReportDeps: HarnessReportProcessorDeps = {
    harnessEventReportIngestion,
    core: options.core,
    eventBus: options.eventBus,
    clock,
    requestReconcile: reconcileScheduler.request,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
  if (providerHealthCache !== undefined) {
    harnessReportDeps.refreshProviderHealth = (providerId) =>
      providerHealthCache.refresh(providerId);
  }

  const harnessIngressQueue = buildHarnessIngressQueue(options, harnessReportDeps, clock);
  harnessIngressQueueRef = harnessIngressQueue;

  const spoolDrainDeps: SpoolDrainDeps = {
    persistence: options.persistence,
    eventBus: options.eventBus,
    clock,
    providerHookIngress,
    harnessIngressQueue,
    harnessReportDeps,
    ...(options.hookSpoolDir === undefined
      ? {}
      : { spoolStore: createFilesystemProviderIngressSpoolStore(options.hookSpoolDir) }),
  };
  const { drainConfiguredSpoolAndQueue } = createSpoolDrainer(spoolDrainDeps);

  reconcileDeps = {
    core: options.core,
    eventBus: options.eventBus,
    clock,
    drainSpoolAndQueue: drainConfiguredSpoolAndQueue,
    ...(metadataRefresh === undefined ? {} : { metadataRefresh }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };

  // Launch reconciles that arrive while the observer.startup scan is still
  // running join that flight (reason rewrapped) instead of queueing a redundant
  // full scan. All other reconciles — scheduler, hooks, external launches, bare
  // `stn reconcile` — must keep the "scan starts at or after the request" property.
  let startupFlight: Promise<ReconcileReceipt> | undefined;
  const startupJoinableReasons = new Set<string>(STARTUP_RECONCILE_REASONS);
  const reconcile = (reason?: string): Promise<ReconcileReceipt> => {
    if (startupFlight !== undefined && reason !== undefined && startupJoinableReasons.has(reason)) {
      return startupFlight.then((receipt) => ({ ...receipt, reason }));
    }
    const flight = runReconcile(reconcileDeps, reconciling, reason);
    if (reason === "observer.startup") {
      startupFlight = flight;
      void flight
        .catch(() => undefined)
        .finally(() => {
          // Identity guard: only the flight that set the stash may clear it.
          if (startupFlight === flight) {
            startupFlight = undefined;
          }
        });
    }
    return flight;
  };

  const api: ObserverApi = {
    health: () => buildHealth(options, clock, harnessIngressQueue),
    stop: () =>
      buildStop(
        options,
        harnessIngressQueue,
        metadataRefresh,
        stopProviderHealthPublication,
        clock,
      ),
    getSnapshot: async () => options.core.getSnapshot(),
    getSessionRecoveryReadiness: async () => sessionRecoveryReadiness(options),
    subscribe: (filter?: EventFilter): AsyncIterable<StationEvent> =>
      options.eventBus.subscribe(filter),
    dispatch: (command: StationCommand) => options.commandQueue.dispatch(command),
    getCommand: (commandId: CommandId) => getCommandById(options, commandId),
    runDoctor: (doctorOptions?: DoctorOptions): Promise<DoctorReport> =>
      runDoctor(buildDiagnosticDeps(options, clock), doctorOptions),
    collectDiagnostics: (
      diagnosticOptions?: DiagnosticCollectionOptions,
    ): Promise<DiagnosticSnapshot> =>
      collectDiagnosticSnapshot(buildDiagnosticDeps(options, clock), diagnosticOptions),
    reconcile,
    ingestProviderHookEvent: (event: ProviderHookEvent): Promise<ProviderHookReceipt> =>
      providerHookIngress.ingest(event),
    reportHarnessEvent: async (report: HarnessEventReport): Promise<HarnessEventReportReceipt> =>
      harnessIngressQueue.enqueue(report),
    prepareExternalLaunch: (params) =>
      prepareExternalLaunchSafe(options, worktreeMutations, reconcileScheduler, params),
    reportExternalExit: (params) => reportExternalExitSafe(options, reconcileScheduler, params),
    prepareWorktreeRemoval: (params) =>
      prepareWorktreeRemovalSafe(options, worktreeMutations, params),
    cancelWorktreeRemoval: (params) =>
      Promise.resolve({ cancelled: worktreeMutations.cancel(params.reservationId) }),
  };

  return api;
}

async function prepareWorktreeRemovalSafe(
  options: CreateObserverApiOptions,
  worktreeMutations: WorktreeMutationCoordinator,
  params: Parameters<ObserverApi["prepareWorktreeRemoval"]>[0],
): ReturnType<ObserverApi["prepareWorktreeRemoval"]> {
  const providers = assertProviderRegistryAvailable(options);
  const snapshotRow = resolveWorktreeRowOrThrow(
    options.core.getSnapshot(),
    params.worktreeId,
    params.projectId,
  );
  const trace = createTraceContext({ operation: "worktree.prepareRemoval" });
  const signal = new AbortController().signal;
  const reservation = await worktreeMutations.reserve(snapshotRow.projectId, snapshotRow.id, () =>
    validateWorktreeRemoval(
      {
        getProjects: () => providerProjectsFromConfig(options.config ?? emptyConfig()),
        providers,
        core: options.core,
        clock: options.clock,
        logger: options.logger,
      },
      params,
      { signal, trace },
    ),
  );
  return {
    reservationId: reservation.id,
    projectId: reservation.projectId,
    worktreeId: reservation.worktreeId,
    externalTerminalExitRequired: reservation.value.externalTerminalExitRequired,
  };
}

function sessionRecoveryReadiness(options: CreateObserverApiOptions): SessionRecoveryReadiness {
  const managedTerminal = options.providers?.managedTerminal;
  const readiness: SessionRecoveryReadiness = {
    resumeEnabled: options.config?.featureFlags?.sessionResumeAgent === true,
    canonicalTitleImport: true,
    harnesses: Array.from(options.providers?.harnesses.values() ?? [])
      .map((provider) => ({
        provider: provider.id,
        canResume: provider.capabilities().canResume,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider)),
  };
  if (managedTerminal !== undefined) {
    readiness.managedTerminal = {
      provider: managedTerminal.id,
      canLaunchProcessPersistently: managedTerminal.capabilities().canLaunchProcessPersistently,
    };
  }
  return readiness;
}

async function prepareExternalLaunchSafe(
  options: CreateObserverApiOptions,
  worktreeMutations: WorktreeMutationCoordinator,
  reconcileScheduler: ReturnType<typeof createReconcileScheduler>,
  params: Parameters<ObserverApi["prepareExternalLaunch"]>[0],
): ReturnType<ObserverApi["prepareExternalLaunch"]> {
  const deps = assertProvidersAvailable(options, worktreeMutations);
  let result: Awaited<ReturnType<typeof prepareExternalLaunch>>;
  try {
    result = await prepareExternalLaunch(deps, params);
  } catch (cause) {
    const error = safeErrorFromUnknown(cause, {
      tag: "ExternalLaunchError",
      code: "EXTERNAL_LAUNCH_PREPARE_FAILED",
      message: "External agent launch preparation failed.",
    });
    if (error.code === "HARNESS_HOOKS_NOT_INSTALLED") {
      const attributes: Record<string, unknown> = {
        error,
        projectId: params.projectId,
        worktreeId: params.worktreeId,
      };
      if (params.harness !== undefined) {
        attributes.harnessProvider = params.harness;
      }
      await options.logger
        ?.warn("External agent launch rejected because harness hooks are unavailable.", attributes)
        .catch(() => undefined);
    }
    throw cause;
  }
  const { outcome, reconcile } = result;
  if (reconcile) {
    reconcileScheduler.request("agent.prepareExternalLaunch");
  }
  return outcome;
}

async function reportExternalExitSafe(
  options: CreateObserverApiOptions,
  reconcileScheduler: ReturnType<typeof createReconcileScheduler>,
  params: Parameters<ObserverApi["reportExternalExit"]>[0],
): ReturnType<ObserverApi["reportExternalExit"]> {
  const providers = assertProviderRegistryAvailable(options);
  const { outcome, reconcile } = await reportExternalExit({ providers }, params);
  if (reconcile) {
    reconcileScheduler.request("agent.reportExternalExit");
  }
  return outcome;
}

function assertProvidersAvailable(
  options: CreateObserverApiOptions,
  worktreeMutations: WorktreeMutationCoordinator,
): ExternalLaunchDeps {
  return {
    core: options.core,
    providers: assertProviderRegistryAvailable(options),
    persistence: options.persistence,
    clock: options.clock,
    configPath: options.configPath,
    sessionResumeAgentEnabled: options.config?.featureFlags?.sessionResumeAgent === true,
    logger: options.logger,
    worktreeMutations,
  };
}

function assertProviderRegistryAvailable(options: CreateObserverApiOptions): ProviderRegistry {
  if (options.providers === undefined) {
    throw {
      tag: "ProviderUnavailableError",
      code: "PROVIDERS_UNAVAILABLE",
      message: "The observer has no provider registry, so external launches are unavailable.",
    };
  }
  return options.providers;
}

function buildMetadataRefresh(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
  scheduler: ReturnType<typeof createReconcileScheduler>,
): WorktreeMetadataRefreshService | undefined {
  if (options.metadataRefresh !== undefined) return options.metadataRefresh;
  if (options.config === undefined) return undefined;

  const resolveWorktree: ResolveLocalGitMetadataWorktree = (target) => {
    const row = options.core
      .getSnapshot()
      .rows.find((candidate) => candidate.id === target.worktreeId);
    if (
      row === undefined ||
      row.projectId !== target.projectId ||
      row.branch !== target.branch ||
      row.registrationIdentity !== target.registrationIdentity
    ) {
      return { status: "superseded" };
    }
    if (row.worktree.state !== "exists") {
      return { status: "unavailable" };
    }
    const worktree = {
      worktreeId: row.id,
      projectId: row.projectId,
      branch: row.branch,
      path: row.path,
      ...(row.registrationIdentity === undefined
        ? {}
        : { registrationIdentity: row.registrationIdentity }),
    };
    return { status: "resolved", worktree };
  };
  const worktreeChangeSource =
    options.worktreeChangeSource ?? createLocalGitWorktreeChangeSource({ resolveWorktree, clock });
  const invalidationOptions: Parameters<
    typeof createLocalGitWorktreeMetadataInvalidationSource
  >[0] = {
    resolveWorktree,
    requestReconcile: scheduler.request,
  };
  if (options.logger !== undefined) invalidationOptions.logger = options.logger;
  const worktreeMetadataInvalidationSource =
    options.worktreeMetadataInvalidationSource ??
    createLocalGitWorktreeMetadataInvalidationSource(invalidationOptions);

  const metadataRefreshOptions: Parameters<typeof createWorktreeMetadataRefreshService>[0] = {
    projects: providerProjectsFromConfig(options.config),
    persistence: options.persistence,
    requestReconcile: scheduler.request,
    clock,
    worktreeChangeSource,
    worktreeMetadataInvalidationSource,
  };
  if (options.logger !== undefined) {
    metadataRefreshOptions.logger = options.logger;
  }
  if (options.providers !== undefined) {
    metadataRefreshOptions.repositoryProviders = options.providers.repositories;
  }
  return createWorktreeMetadataRefreshService(metadataRefreshOptions);
}

function buildProviderHookIngress(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
  scheduler: ReturnType<typeof createReconcileScheduler>,
  reportHarnessEvent: (report: HarnessEventReport) => Promise<HarnessEventReportReceipt>,
): ProviderHookIngress {
  if (options.providerHookIngress !== undefined) return options.providerHookIngress;
  return createProviderHookIngress({
    persistence: options.persistence,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    eventBus: options.eventBus,
    clock,
    requestReconcile: scheduler.request,
    reportHarnessEvent,
  });
}

function buildHarnessEventReportIngestion(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
): HarnessEventReportIngestion {
  if (options.harnessEventReportIngestion !== undefined) return options.harnessEventReportIngestion;
  return createHarnessEventReportIngestion({
    persistence: options.persistence,
    eventBus: options.eventBus,
    clock,
    ...(options.config?.observability?.retention === undefined
      ? {}
      : { retention: options.config.observability.retention }),
  });
}

function buildHarnessIngressQueue(
  options: CreateObserverApiOptions,
  harnessReportDeps: HarnessReportProcessorDeps,
  clock: RuntimeClock,
): HarnessIngressQueue {
  if (options.harnessIngressQueue !== undefined) return options.harnessIngressQueue;
  return createHarnessIngressQueue({
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    processReport: (report) => processHarnessIngressReport(harnessReportDeps, report),
  });
}

async function buildHealth(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
  harnessIngressQueue: HarnessIngressQueue,
): Promise<ObserverHealth> {
  const coreHealth = options.core.getHealth();
  const snapshot = options.core.getSnapshot();
  const spoolDepth =
    options.hookSpoolDir === undefined
      ? undefined
      : await providerIngressSpoolDepth(options.hookSpoolDir);

  const health: ObserverHealth = {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: coreHealth.status,
    pid: snapshot.observer.pid,
    startedAt: coreHealth.startedAt,
    version: options.observerBuildVersion ?? snapshot.observer.version,
    uptimeMs: Math.max(
      0,
      Date.parse(toIsoTimestamp(clock.now())) - Date.parse(coreHealth.startedAt),
    ),
    providerHealth: coreHealth.providerHealth,
  };
  if (options.socketPath !== undefined) health.socketPath = options.socketPath;
  if (options.stateDir !== undefined) health.stateDir = options.stateDir;
  if (spoolDepth !== undefined) health.hookSpoolDepth = spoolDepth;
  health.harnessIngressQueue = harnessIngressQueue.health();
  health.sqlite = options.persistenceHealth.health();
  if (coreHealth.lastReconcile !== undefined) health.lastReconcile = coreHealth.lastReconcile;
  return health;
}

async function buildStop(
  options: CreateObserverApiOptions,
  harnessIngressQueue: HarnessIngressQueue,
  metadataRefresh: WorktreeMetadataRefreshService | undefined,
  stopProviderHealthPublication: () => Promise<void>,
  clock: RuntimeClock,
): Promise<ObserverStopReceipt> {
  await options.onShutdownStarted?.();
  const providerHealthStopped = stopProviderHealthPublication();
  await harnessIngressQueue.shutdown();
  await metadataRefresh?.shutdown();
  await providerHealthStopped;
  await options.onStop?.();
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    stopped: true,
    at: toIsoTimestamp(clock.now()),
  };
}

async function getCommandById(
  options: CreateObserverApiOptions,
  commandId: CommandId,
): Promise<CommandRecord | undefined> {
  const command = await options.persistence.getCommand(commandId);
  return command === undefined ? undefined : commandRecordFromPersisted(command);
}

function buildDiagnosticDeps(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
): ObserverDiagnosticsDeps {
  const deps: ObserverDiagnosticsDeps = {
    config: options.config ?? emptyConfig(),
    core: options.core,
    commandJournal: options.persistence,
    eventJournal: options.persistence,
    persistenceHealth: options.persistenceHealth,
    evidenceSource: options.diagnosticEvidenceSource,
    clock,
  };
  if (options.configPath !== undefined) deps.configPath = options.configPath;
  if (options.configDiagnostics !== undefined) {
    deps.configDiagnostics = options.configDiagnostics;
  }
  if (options.providers !== undefined) deps.providers = options.providers;
  if (options.duplicateInspection !== undefined) {
    deps.duplicateInspection = options.duplicateInspection;
  }
  return deps;
}
