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
  ProviderHookEvent,
  ProviderHookReceipt,
  ReconcileReceipt,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import { STARTUP_RECONCILE_REASONS, STATION_SCHEMA_VERSION } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import type { CommandQueue } from "../commands/queue.js";
import { commandRecordFromPersisted } from "../commands/record.js";
import {
  collectDiagnosticSnapshot,
  type DiagnosticRuntimePaths,
  type ObserverDiagnosticsDeps,
  runDoctor,
} from "../diagnostics/collector.js";
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
import { providerIngressSpoolDepth } from "../hooks/spool.js";
import {
  createWorktreeMetadataRefreshService,
  type WorktreeMetadataRefreshService,
} from "../metadata/refresh.js";
import type { ObserverPersistence } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { type ObserverCore, providerProjectsFromConfig } from "../reconcile/core.js";
import type { ObserverEventBus } from "./eventBus.js";
import {
  type ExternalLaunchDeps,
  prepareExternalLaunch,
  reportExternalExit,
} from "./externalLaunch.js";
import type { HarnessReportProcessorDeps } from "./harnessReportProcessor.js";
import { processHarnessIngressReport } from "./harnessReportProcessor.js";
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
  persistence: ObserverPersistence;
  commandQueue: CommandQueue;
  eventBus: ObserverEventBus;
  clock?: RuntimeClock;
  providerHookIngress?: ProviderHookIngress;
  harnessEventReportIngestion?: HarnessEventReportIngestion;
  harnessIngressQueue?: HarnessIngressQueue;
  hookSpoolDir?: string;
  socketPath?: string;
  stateDir?: string;
  diagnosticsDir?: string;
  logPaths?: string[];
  logger?: JsonlLogger;
  config?: StationConfig;
  configPath?: string;
  configDiagnostics?: ConfigDiagnostic[];
  metadataRefresh?: WorktreeMetadataRefreshService;
  onStop?: () => Promise<void> | void;
  hookReconcileDebounceMs?: number;
};

export function createObserverApi(options: CreateObserverApiOptions): ObserverApi {
  const clock = options.clock ?? systemClock;
  const reconciling = { reconciling: false };

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
  const harnessEventReportIngestion = buildHarnessEventReportIngestion(
    options,
    clock,
    reconcileScheduler,
  );

  const harnessReportDeps: HarnessReportProcessorDeps = {
    harnessEventReportIngestion,
    core: options.core,
    eventBus: options.eventBus,
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };

  const harnessIngressQueue = buildHarnessIngressQueue(
    options,
    harnessReportDeps,
    clock,
    reconcileScheduler,
  );
  harnessIngressQueueRef = harnessIngressQueue;

  const spoolDrainDeps: SpoolDrainDeps = {
    persistence: options.persistence,
    eventBus: options.eventBus,
    clock,
    providerHookIngress,
    harnessIngressQueue,
    harnessReportDeps,
    reconcileScheduler,
    ...(options.hookSpoolDir === undefined ? {} : { hookSpoolDir: options.hookSpoolDir }),
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
    stop: () => buildStop(options, harnessIngressQueue, metadataRefresh, clock),
    getSnapshot: async () => options.core.getSnapshot(),
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
      prepareExternalLaunchSafe(options, reconciling, reconcileDeps, params),
    reportExternalExit: (params) =>
      reportExternalExitSafe(options, reconciling, reconcileDeps, params),
  };

  return api;
}

function reconcileAfterExternalLaunch(
  deps: ReconcileExecutorDeps,
  guard: { reconciling: boolean },
  reason: string,
  logger?: JsonlLogger,
): void {
  void runReconcile(deps, guard, reason).catch(async (error) => {
    await logger?.error("Post-external-launch reconcile failed.", { reason, error });
  });
}

async function prepareExternalLaunchSafe(
  options: CreateObserverApiOptions,
  reconciling: { reconciling: boolean },
  reconcileDeps: ReconcileExecutorDeps,
  params: Parameters<ObserverApi["prepareExternalLaunch"]>[0],
): ReturnType<ObserverApi["prepareExternalLaunch"]> {
  const deps = assertProvidersAvailable(options);
  const { outcome, reconcile } = await prepareExternalLaunch(deps, params);
  if (reconcile) {
    reconcileAfterExternalLaunch(
      reconcileDeps,
      reconciling,
      "agent.prepareExternalLaunch",
      options.logger,
    );
  }
  return outcome;
}

async function reportExternalExitSafe(
  options: CreateObserverApiOptions,
  reconciling: { reconciling: boolean },
  reconcileDeps: ReconcileExecutorDeps,
  params: Parameters<ObserverApi["reportExternalExit"]>[0],
): ReturnType<ObserverApi["reportExternalExit"]> {
  const deps = assertProvidersAvailable(options);
  const { outcome, reconcile } = await reportExternalExit(deps, params);
  if (reconcile) {
    reconcileAfterExternalLaunch(
      reconcileDeps,
      reconciling,
      "agent.reportExternalExit",
      options.logger,
    );
  }
  return outcome;
}

function assertProvidersAvailable(options: CreateObserverApiOptions): ExternalLaunchDeps {
  if (options.providers === undefined) {
    throw {
      tag: "ProviderUnavailableError",
      code: "PROVIDERS_UNAVAILABLE",
      message: "The observer has no provider registry, so external launches are unavailable.",
    };
  }
  return {
    core: options.core,
    providers: options.providers,
    persistence: options.persistence,
    clock: options.clock,
    configPath: options.configPath,
  };
}

function buildMetadataRefresh(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
  scheduler: ReturnType<typeof createReconcileScheduler>,
): WorktreeMetadataRefreshService | undefined {
  if (options.metadataRefresh !== undefined) return options.metadataRefresh;
  if (options.config === undefined) return undefined;

  const metadataRefreshOptions: Parameters<typeof createWorktreeMetadataRefreshService>[0] = {
    projects: providerProjectsFromConfig(options.config),
    persistence: options.persistence,
    requestReconcile: scheduler.request,
    clock,
    watchGitRefs: true,
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
    projects: providerProjectsFromConfig(options.config ?? emptyConfig()),
    eventBus: options.eventBus,
    clock,
    ...(options.config?.observability?.retention === undefined
      ? {}
      : { retention: options.config.observability.retention }),
    requestReconcile: scheduler.request,
    reportHarnessEvent,
  });
}

function buildHarnessEventReportIngestion(
  options: CreateObserverApiOptions,
  clock: RuntimeClock,
  scheduler: ReturnType<typeof createReconcileScheduler>,
): HarnessEventReportIngestion {
  if (options.harnessEventReportIngestion !== undefined) return options.harnessEventReportIngestion;
  return createHarnessEventReportIngestion({
    persistence: options.persistence,
    eventBus: options.eventBus,
    clock,
    ...(options.config?.observability?.retention === undefined
      ? {}
      : { retention: options.config.observability.retention }),
    requestReconcile: scheduler.request,
  });
}

function buildHarnessIngressQueue(
  options: CreateObserverApiOptions,
  harnessReportDeps: HarnessReportProcessorDeps,
  clock: RuntimeClock,
  scheduler: ReturnType<typeof createReconcileScheduler>,
): HarnessIngressQueue {
  if (options.harnessIngressQueue !== undefined) return options.harnessIngressQueue;
  return createHarnessIngressQueue({
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    requestReconcile: scheduler.request,
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
    version: snapshot.observer.version,
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
  if (coreHealth.sqlite !== undefined) health.sqlite = coreHealth.sqlite;
  if (coreHealth.lastReconcile !== undefined) health.lastReconcile = coreHealth.lastReconcile;
  return health;
}

async function buildStop(
  options: CreateObserverApiOptions,
  harnessIngressQueue: HarnessIngressQueue,
  metadataRefresh: WorktreeMetadataRefreshService | undefined,
  clock: RuntimeClock,
): Promise<ObserverStopReceipt> {
  await harnessIngressQueue.shutdown();
  await metadataRefresh?.shutdown?.();
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
): ObserverDiagnosticsDeps & { paths: DiagnosticRuntimePaths } {
  const stateDir = options.stateDir ?? process.cwd();
  const paths: DiagnosticRuntimePaths = {
    stateDir,
    diagnosticsDir: options.diagnosticsDir ?? `${stateDir}/diagnostics`,
  };
  if (options.socketPath !== undefined) paths.socketPath = options.socketPath;
  if (options.hookSpoolDir !== undefined) paths.hookSpoolDir = options.hookSpoolDir;
  if (options.logPaths !== undefined) paths.logPaths = options.logPaths;

  const deps: ObserverDiagnosticsDeps & { paths: DiagnosticRuntimePaths } = {
    config: options.config ?? emptyConfig(),
    core: options.core,
    persistence: options.persistence,
    paths,
    clock,
  };
  if (options.configPath !== undefined) deps.configPath = options.configPath;
  if (options.configDiagnostics !== undefined) {
    deps.configDiagnostics = options.configDiagnostics;
  }
  if (options.providers !== undefined) deps.providers = options.providers;
  return deps;
}

export { agentStateChangedEventsFromReconcile } from "./agentEvents.js";
export { elapsedMs } from "./reconcileProfiling.js";
