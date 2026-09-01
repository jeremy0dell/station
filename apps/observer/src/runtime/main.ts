#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  emptyConfig,
  type LoadedStationConfig,
  loadConfig,
  type StationConfig,
} from "@station/config";
import {
  type ObserverApi,
  type ObserverProcessIdentity,
  ObserverProcessTokenSchema,
  type ObserverStaleEvidenceRepairSummary,
  type ObserverStopReceipt,
  type SafeError,
} from "@station/contracts";
import { componentLogPath } from "@station/observability";
import {
  parseStationObserverBuildVersion,
  safeErrorFromUnknown,
  stationObserverBuildVersion,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { throwIfAborted } from "../commands/cancellation.js";
import { reconcileConfiguredHarnessHooksOrThrow } from "../commands/harnessHookReconciliation.js";
import {
  assertHarnessLaunchPreconditionsOrThrow,
  type HarnessLaunchPreflight,
} from "../commands/harnessLaunchPreflight.js";
import { createCommandQueue } from "../commands/queue.js";
import { registerObserverCommandHandlers } from "../commands/router.js";
import { createLocalDiagnosticEvidenceSource } from "../diagnostics/localEvidenceSource.js";
import { createFeatureFlagEvaluator } from "../features/evaluator.js";
import {
  createObserverEventHookRuntime,
  type ObserverEventHookRuntime,
} from "../hooks/observerEventHooks.js";
import { providerIngressSpoolDir } from "../hooks/spool.js";
import { createSqliteObserverPersistence } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createObserverCore, providerProjectsFromConfig } from "../reconcile/core.js";
import { openObserverSqlite } from "../sqlite.js";
import type { StationLogger } from "../stationLogger.js";
import { createWorktreeCreateCoordinator } from "../worktreeCreateCoordinator.js";
import { createWorktreeMutationCoordinator } from "../worktreeMutationCoordinator.js";
import { createObserverApi } from "./api.js";
import { createObserverEventBus } from "./eventBus.js";
import { runShutdownWithBackstop } from "./gracefulExit.js";
import { createObserverLogger } from "./logging.js";
import {
  type AcquiredObserverBootClaim,
  acquireObserverBootClaim,
  type ObserverBootClaimReleaseResult,
} from "./observerBootClaim.js";
import {
  observerEvidenceOwnerChangedRefusal,
  repairStaleObserverEvidence,
} from "./observerEvidenceRepair.js";
import {
  negotiateObserverIncumbent,
  type ObserverIncumbentLifecycle,
  type ObserverProcessEvidenceSource,
} from "./observerHandoff.js";
import {
  createLocalObserverProcessIdentityRepair,
  createObserverProcessIdentity,
  publishObserverProcessIdentity,
  removeObserverProcessIdentity,
} from "./observerPidfile.js";
import { createLocalObserverProcessEvidence } from "./observerProcessEvidence.js";
import type {
  ObserverProcessExistenceEvidenceSource,
  ObserverProcessIdentityRepair,
} from "./observerProcessIdentity.js";
import {
  inspectObserverDuplicates,
  type ObserverDuplicateProcessEvidenceSource,
  type ObserverReapPlan,
} from "./observerReap.js";
import { createProjectConfigWriter } from "./projectConfigWriter.js";
import {
  createObserverLifecycleClient,
  type ObserverServer,
  probeObserverSocket,
  startObserverServer,
} from "./server.js";
import {
  readSocketIdentity,
  type SocketIdentity,
  type SocketOwnershipWatch,
  watchSocketOwnership,
} from "./socketOwnership.js";

// Ceiling on a graceful stop; a wedged drain (a handler ignoring its abort)
// force-exits at this point instead of keeping the observer alive forever.
const STOP_BACKSTOP_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MIN_STARTUP_BUDGET_MS = 1;
const HANDOFF_PARENT_RESERVE_RATIO = 0.3;
const HANDOFF_PARENT_RESERVE_MIN_MS = 2000;
const HANDOFF_PARENT_RESERVE_MAX_MS = 3000;

export type ObserverProviderRegistryFactoryOptions = {
  stateDir: string;
  configPath?: string | undefined;
};

export type ObserverProviderRegistryFactory = (
  config: StationConfig,
  options: ObserverProviderRegistryFactoryOptions,
) => ProviderRegistry | Promise<ProviderRegistry>;

type ObserverProviderPreparation = (request: { timeoutMs: number }) => Promise<ProviderRegistry>;

/**
 * DRIVEN PORT
 *
 * Notifies the spawning process that startup publication completed so its
 * private failure-report channel can close without waiting for process exit.
 */
export interface ObserverStartupReadinessSink {
  ready(): void;
}

export type RunObserverMainDeps = {
  providerRegistryFactory: ObserverProviderRegistryFactory;
  /** Exact Observer build selector; defaults to the running artifact selector. */
  buildVersion?: string;
  incumbentLifecycle?: ObserverIncumbentLifecycle;
  processEvidence?: ObserverProcessEvidenceSource;
  processExistenceEvidence?: ObserverProcessExistenceEvidenceSource;
  processIdentityRepair?: ObserverProcessIdentityRepair;
  duplicateProcessEvidence?: ObserverDuplicateProcessEvidenceSource;
  handoffNow?: () => number;
  handoffSleep?: (ms: number) => Promise<void>;
  /** Test/composition override for the child-side incumbent admission policy. */
  startupPolicy?: "generic" | "preserve-incumbent";
  startupReadinessSink?: ObserverStartupReadinessSink;
  exit?: (code: number) => void;
};

/**
 * COMPOSITION ROOT
 *
 * Claims boot ownership, branches on four-state socket evidence, repairs only
 * positively stale strict pidfile evidence, selects Observer-private infrastructure
 * from resolved runtime identity, and owns bind, pidfile, read-only duplicate
 * inspection, ownership-aware shutdown, and exact build health publication.
 * Successful publication notifies the injected readiness sink; startup rejection
 * retains the original failure after best-effort cleanup.
 */
export async function runObserverMain(
  argv = process.argv.slice(2),
  deps: RunObserverMainDeps,
): Promise<number> {
  const options = parseArgs(argv);
  const loadedConfig: LoadedStationConfig =
    options.configPath === undefined
      ? {
          configPath: "",
          config: emptyConfig(),
          projects: [],
          diagnostics: [],
        }
      : await loadConfig(options.configPath);
  const config = loadedConfig.config;
  const homeDir = homedir();
  const stateDir = resolvePath(
    options.stateDir ?? config.observer?.stateDir ?? "~/.local/state/station",
    homeDir,
  );
  const socketPath = resolveObserverSocketPath(options.socketPath, config, stateDir, homeDir);
  const buildVersion = deps.buildVersion ?? stationObserverBuildVersion();
  if (options.buildVersion !== undefined && options.buildVersion !== buildVersion) {
    throw new Error("--build-version must match the running Observer build selector.");
  }
  const handoffNow = deps.handoffNow ?? Date.now;
  const startupPolicy = deps.startupPolicy ?? observerStartupPolicy(process.env);
  // This is one-child admission authority, not launch context for providers or hosted agents.
  delete process.env.STATION_OBSERVER_STARTUP_POLICY;
  const startupDeadline = handoffNow() + options.startupTimeoutMs;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const claimResult = await acquireObserverBootClaim({
    socketPath,
    timeoutMs: Math.max(MIN_STARTUP_BUDGET_MS, startupDeadline - handoffNow()),
  });
  if (claimResult.status !== "acquired") {
    throw claimResult.error;
  }
  const startupSignals = createObserverStartupSignalController();
  const prepareProviders = createObserverProviderPreparation({
    deps,
    config,
    stateDir,
    ...(options.configPath === undefined ? {} : { configPath: loadedConfig.configPath }),
    startupDeadline,
    now: handoffNow,
    signal: startupSignals.signal,
  });

  // This outer lifetime keeps the claim through any pre-ready socket and
  // pidfile cleanup; the ready gate performs the normal early release.
  try {
    const probeTimeoutMs = Math.max(MIN_STARTUP_BUDGET_MS, startupDeadline - handoffNow());
    const localProcessEvidence = createLocalObserverProcessEvidence({
      evidenceTimeoutMs: Math.max(
        MIN_STARTUP_BUDGET_MS,
        Math.min(1_000, startupDeadline - handoffNow()),
      ),
    });
    const processEvidence = deps.processEvidence ?? localProcessEvidence;
    const processExistenceEvidence = deps.processExistenceEvidence ?? localProcessEvidence;
    const socketProbe = await probeObserverSocket(socketPath, {
      timeoutMs: probeTimeoutMs,
      socketHolders: (path: string) => processEvidence.socketHolders(path),
    });
    if (socketProbe.status === "inaccessible") throw socketProbe.error;
    if (socketProbe.status === "listening") {
      const remainingStartupMs = Math.max(MIN_STARTUP_BUDGET_MS, startupDeadline - handoffNow());
      if (startupPolicy === "preserve-incumbent") {
        const lifecycle =
          deps.incumbentLifecycle ??
          createObserverLifecycleClient({ timeoutMs: remainingStartupMs });
        const incumbent = await lifecycle.health(socketPath, {
          timeoutMs: remainingStartupMs,
        });
        if (incumbent.version === buildVersion) {
          throwIfAborted(startupSignals.signal);
          notifyObserverStartupReady(deps.startupReadinessSink);
          return 0;
        }
        throw preserveIncumbentRefusal(
          socketPath,
          incumbent.version ?? "legacy/unknown build",
          buildVersion,
        );
      }
      const parentReserveMs = Math.min(
        HANDOFF_PARENT_RESERVE_MAX_MS,
        Math.max(
          HANDOFF_PARENT_RESERVE_MIN_MS,
          Math.floor(remainingStartupMs * HANDOFF_PARENT_RESERVE_RATIO),
        ),
        Math.max(0, remainingStartupMs - MIN_STARTUP_BUDGET_MS),
      );
      const handoffTimeoutMs = Math.max(
        MIN_STARTUP_BUDGET_MS,
        remainingStartupMs - parentReserveMs,
      );
      const result = await negotiateObserverIncumbent(
        {
          socketPath,
          candidate: {
            version: buildVersion,
            startedAt: toIsoTimestamp(systemClock.now()),
            pid: process.pid,
          },
          // Reserve parent-budget time for successor bind, publication, and health convergence.
          timeoutMs: handoffTimeoutMs,
        },
        {
          lifecycle:
            deps.incumbentLifecycle ??
            createObserverLifecycleClient({ timeoutMs: handoffTimeoutMs }),
          evidence: processEvidence,
          now: handoffNow,
          ...(deps.handoffSleep === undefined ? {} : { sleep: deps.handoffSleep }),
          prepareReplacement: async ({ timeoutMs }) => {
            await prepareProviders({ timeoutMs });
          },
          commitReplacement: startupSignals.commitReplacement,
        },
      );
      if (result.action === "attach") {
        throwIfAborted(startupSignals.signal);
        notifyObserverStartupReady(deps.startupReadinessSink);
        return 0;
      }
    }
    const repairProbe =
      socketProbe.status === "listening"
        ? await probeObserverSocket(socketPath, {
            timeoutMs: Math.max(MIN_STARTUP_BUDGET_MS, startupDeadline - handoffNow()),
            socketHolders: (path: string) => processEvidence.socketHolders(path),
          })
        : socketProbe;
    if (repairProbe.status === "listening") {
      throw observerEvidenceOwnerChangedRefusal();
    }
    if (repairProbe.status === "inaccessible") throw repairProbe.error;
    const processIdentityRepair =
      deps.processIdentityRepair ?? createLocalObserverProcessIdentityRepair();
    const evidenceRepair = await repairStaleObserverEvidence(
      {
        socketPath,
        socketProbe: repairProbe,
        deadlineMs: startupDeadline,
      },
      {
        processEvidence: {
          readObserverProcess: processEvidence.readObserverProcess,
          processStartToken: processEvidence.processStartToken,
          readProcessExistence: processExistenceEvidence.readProcessExistence,
        },
        identityRepair: processIdentityRepair,
        probeSocket: () =>
          probeObserverSocket(socketPath, {
            timeoutMs: Math.max(MIN_STARTUP_BUDGET_MS, startupDeadline - handoffNow()),
            socketHolders: (path: string) => processEvidence.socketHolders(path),
          }),
        now: handoffNow,
      },
    );
    return await runClaimedObserverRuntime({
      options,
      loadedConfig,
      stateDir,
      socketPath,
      buildVersion,
      homeDir,
      claim: claimResult,
      evidenceRepair,
      deps,
      prepareProviders,
      startupDeadline,
      startupNow: handoffNow,
      startupSignals,
    });
  } finally {
    startupSignals.dispose();
    releaseObserverBootClaim(claimResult);
  }
}

type ObserverStartupSignalController = {
  signal: AbortSignal;
  commitReplacement(): void;
  activate(onSignal: () => void): void;
  dispose(): void;
};

function createObserverStartupSignalController(): ObserverStartupSignalController {
  const controller = new AbortController();
  let onSignal: (() => void) | undefined;
  let replacementCommitted = false;
  let signalReceived = false;
  const abortFor = (signal: "SIGINT" | "SIGTERM") => {
    signalReceived = true;
    if (!replacementCommitted && !controller.signal.aborted) {
      const safeError: SafeError = {
        tag: "ObserverStartupError",
        code: "OBSERVER_STARTUP_CANCELLED",
        message: `Observer startup was cancelled by ${signal}.`,
      };
      controller.abort(Object.assign(new Error(safeError.message), safeError));
    }
    onSignal?.();
  };
  const onSigint = () => abortFor("SIGINT");
  const onSigterm = () => abortFor("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    commitReplacement: () => {
      // No signal callback can interleave with this synchronous check-and-commit transition.
      throwIfAborted(controller.signal);
      replacementCommitted = true;
    },
    activate: (callback) => {
      onSignal = callback;
      if (signalReceived) callback();
    },
    dispose: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      onSignal = undefined;
    },
  };
}

function createObserverProviderPreparation(input: {
  deps: RunObserverMainDeps;
  config: StationConfig;
  stateDir: string;
  configPath?: string;
  startupDeadline: number;
  now: () => number;
  signal: AbortSignal;
}): ObserverProviderPreparation {
  let preparation: Promise<ProviderRegistry> | undefined;
  return (request) => {
    preparation ??= (async () => {
      throwIfAborted(input.signal);
      const providerOptions: ObserverProviderRegistryFactoryOptions = { stateDir: input.stateDir };
      if (input.configPath !== undefined) providerOptions.configPath = input.configPath;
      const providers = await input.deps.providerRegistryFactory(input.config, providerOptions);
      throwIfAborted(input.signal);
      // The boot claim is the startup serialization authority; configured hooks must verify
      // before an incumbent is stopped or any successor runtime state is published.
      await reconcileConfiguredHarnessHooksOrThrow({
        providers,
        ...(input.configPath === undefined ? {} : { stationConfigPath: input.configPath }),
        signal: input.signal,
        timeoutMs: Math.min(
          request.timeoutMs,
          remainingObserverStartupMs(input.startupDeadline, input.now),
        ),
      });
      throwIfAborted(input.signal);
      return providers;
    })();
    return preparation;
  };
}

function remainingObserverStartupMs(deadline: number, now: () => number): number {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) {
    const safeError: SafeError = {
      tag: "ObserverStartupError",
      code: "OBSERVER_STARTUP_TIMEOUT",
      message: "Observer startup did not complete before its deadline.",
    };
    throw Object.assign(new Error(safeError.message), safeError);
  }
  return remaining;
}

/** Reads the internal child policy strictly so inherited or misspelled values fail closed. */
function observerStartupPolicy(
  env: Readonly<Record<string, string | undefined>>,
): "generic" | "preserve-incumbent" {
  const value = env.STATION_OBSERVER_STARTUP_POLICY;
  if (value === undefined || value === "") return "generic";
  if (value === "preserve-incumbent") return value;
  throw new Error("STATION_OBSERVER_STARTUP_POLICY must be empty or preserve-incumbent.");
}

function preserveIncumbentRefusal(
  socketPath: string,
  incumbentVersion: string,
  requestedVersion: string,
): Error & SafeError {
  const safeError: SafeError = {
    tag: "ObserverStartupError",
    code: "OBSERVER_EXACT_BUILD_ACTIVATION_FAILED",
    message: "The exact Observer build could not claim the configured socket safely.",
    hint: `A different Observer (${incumbentVersion}) claimed ${socketPath} before ${requestedVersion} could start. That new owner was preserved.`,
  };
  return Object.assign(new Error(safeError.message), safeError);
}

async function runClaimedObserverRuntime(input: {
  options: ReturnType<typeof parseArgs>;
  loadedConfig: LoadedStationConfig;
  stateDir: string;
  socketPath: string;
  buildVersion: string;
  homeDir: string;
  claim: AcquiredObserverBootClaim;
  evidenceRepair: ObserverStaleEvidenceRepairSummary;
  deps: RunObserverMainDeps;
  prepareProviders: ObserverProviderPreparation;
  startupDeadline: number;
  startupNow: () => number;
  startupSignals: ObserverStartupSignalController;
}): Promise<number> {
  const {
    options,
    loadedConfig,
    stateDir,
    socketPath,
    buildVersion,
    homeDir,
    claim,
    evidenceRepair,
    deps,
    prepareProviders,
    startupDeadline,
    startupNow,
    startupSignals,
  } = input;
  const observerVersion = parseStationObserverBuildVersion(buildVersion).version;
  const config = loadedConfig.config;
  const spoolDir = providerIngressSpoolDir(stateDir);
  const providers = await prepareProviders({
    timeoutMs: remainingObserverStartupMs(startupDeadline, startupNow),
  });
  throwIfAborted(startupSignals.signal);

  const sqlite = openObserverSqlite({
    path: join(stateDir, "observer.sqlite"),
    clock: systemClock,
  });
  const persistence = createSqliteObserverPersistence({ sqlite, clock: systemClock });
  const eventBus = createObserverEventBus();
  const logger = createObserverLogger({ stateDir, clock: systemClock });
  if (evidenceRepair.pidfile === "removed") {
    await logger.info("Observer stale pidfile evidence repaired.", {
      socketPath,
      socket: evidenceRepair.socket,
      reason: evidenceRepair.reason,
    });
  }
  const diagnosticEvidenceSource = createLocalDiagnosticEvidenceSource({
    stateDir,
    socketPath,
    diagnosticsDir: join(stateDir, "diagnostics"),
    logPaths: [componentLogPath(stateDir, "observer"), componentLogPath(stateDir, "hook")],
    hookSpoolDir: spoolDir,
  });
  const projectConfigWriter = createProjectConfigWriter({
    homeDir,
    ...(options.configPath === undefined ? {} : { configPath: loadedConfig.configPath }),
  });
  const pruneAt = toIsoTimestamp(systemClock.now());
  await persistence.pruneExpiredProviderObservations(pruneAt);
  const commandQueue = createCommandQueue({ persistence, clock: systemClock, eventBus, logger });
  const worktreeMutations = createWorktreeMutationCoordinator();
  const worktreeCreates = createWorktreeCreateCoordinator();
  // Fire-and-forget version probes only populate provider-owned cache state.
  void providers.refreshHarnessVersions();
  const featureFlags = createFeatureFlagEvaluator({
    ...(config.featureFlags === undefined ? {} : { overrides: config.featureFlags }),
    revisionSeed: loadedConfig.configPath,
  });
  const core = createObserverCore({
    config,
    providers,
    persistence,
    clock: systemClock,
    logger,
    featureFlags,
    version: observerVersion,
  });
  const launchPreflight: HarnessLaunchPreflight = (providerId, context) =>
    assertHarnessLaunchPreconditionsOrThrow({
      providers,
      providerId,
      ...(options.configPath === undefined ? {} : { stationConfigPath: loadedConfig.configPath }),
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
      ...(context?.beginMutation === undefined ? {} : { beginMutation: context.beginMutation }),
    });
  registerObserverCommandHandlers({
    queue: commandQueue,
    core,
    providers,
    projects: providerProjectsFromConfig(config),
    getProjects: () => core.getProjects(),
    persistence,
    featureFlags,
    eventBus,
    clock: systemClock,
    logger,
    projectConfigWriter,
    launchPreflight,
    worktreeMutations,
    worktreeCreates,
  });
  const eventHooks = createConfiguredEventHooks(config, eventBus, logger);
  const duplicateProcessEvidence =
    deps.duplicateProcessEvidence ?? createLocalObserverProcessEvidence();

  let server: ObserverServer | undefined;
  let ownership: SocketOwnershipWatch | undefined;
  let ownsSocket = false;
  let boundSocketIdentity: SocketIdentity | undefined;
  let processIdentity: ObserverProcessIdentity | undefined;
  let duplicateInspectionFlight: Promise<ObserverReapPlan> | undefined;
  const startupGate = createObserverStartupGate();
  let stopResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopping: Promise<void> | undefined;
  let stopReceipt: Promise<ObserverStopReceipt> | undefined;
  let observerApi: ObserverApi;
  let shutdownExitCode = 0;
  let displaced = false;
  const stopFromSignal = () => {
    void api.stop();
  };
  const stopObserver = async (exitCode = 0) => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    stopping ??= runShutdownWithBackstop(
      async () => {
        let shutdownError: unknown;
        stopReceipt ??= (async () => {
          // Publication must settle before cleanup so a pre-ready stop cannot
          // leave a late pidfile behind or release the boot claim too early.
          await startupGate.waitUntilSettled();
          return observerApi.stop();
        })();
        try {
          await stopReceipt;
        } catch (error) {
          shutdownError = error;
        }
        try {
          await commandQueue.shutdown();
        } catch (error) {
          shutdownError ??= error;
        }
        try {
          await eventHooks?.shutdown();
        } catch (error) {
          shutdownError ??= error;
        }
        // Cleanup is ownership-checked so a displaced Observer cannot delete its successor's pidfile.
        const currentSocketIdentity = await readSocketIdentity(socketPath);
        const stillOwnsSocket =
          ownsSocket &&
          boundSocketIdentity !== undefined &&
          currentSocketIdentity?.ino === boundSocketIdentity.ino &&
          currentSocketIdentity.birthtimeNs === boundSocketIdentity.birthtimeNs;
        ownsSocket = stillOwnsSocket;
        if (stillOwnsSocket && processIdentity !== undefined) {
          try {
            await removeObserverProcessIdentity(processIdentity);
          } catch (error) {
            await warnIdentityCleanupFailed(logger, socketPath, processIdentity.pid, error);
          }
        }
        ownership?.stop();
        // Runtime close may unlink the bound pathname, so ownership is revalidated with no await
        // between this check and close; a stale check could remove a successor's socket.
        const identityAtClose = stillOwnsSocket ? await readSocketIdentity(socketPath) : undefined;
        const ownsSocketAtClose =
          boundSocketIdentity !== undefined &&
          identityAtClose?.ino === boundSocketIdentity.ino &&
          identityAtClose.birthtimeNs === boundSocketIdentity.birthtimeNs;
        if (ownsSocketAtClose) {
          try {
            await server?.close();
          } catch (error) {
            shutdownError ??= error;
          }
        } else {
          // Displaced shutdown must preserve the successor socket and every pidfile.
          server?.abandon();
          displaced = true;
        }
        ownsSocket = false;
        stopResolve();
        if (shutdownError !== undefined) {
          throw shutdownError;
        }
      },
      STOP_BACKSTOP_MS,
      {
        exit: () => process.exit(shutdownExitCode),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      },
    );
    await stopping;
  };
  observerApi = createObserverApi({
    core,
    providers,
    persistence,
    persistenceHealth: persistence,
    commandQueue,
    worktreeMutations,
    worktreeCreates,
    eventBus,
    diagnosticEvidenceSource,
    hookSpoolDir: spoolDir,
    socketPath,
    observerBuildVersion: buildVersion,
    stateDir,
    config,
    ...(options.configPath === undefined ? {} : { configPath: loadedConfig.configPath }),
    configDiagnostics: loadedConfig.diagnostics,
    clock: systemClock,
    logger,
    duplicateInspection: () => duplicateInspectionFlight,
  });
  // Register health publication before boot probes so every completed result reaches the snapshot.
  void providers.healthCache.refreshAll();
  const api: ObserverApi = {
    ...observerApi,
    health: () => startupGate.runHealth(observerApi.health),
    stop: async () => {
      startupGate.requestStop();
      const shutdown = stopObserver();
      void shutdown.catch((error) =>
        logger.error("Observer shutdown failed.", { socketPath, error }).catch(() => undefined),
      );
      if (stopReceipt === undefined) {
        throw new Error("Observer shutdown did not initialize.");
      }
      return stopReceipt;
    },
  };
  startupSignals.activate(stopFromSignal);

  let shouldReconcile = false;
  try {
    throwIfAborted(startupSignals.signal);
    // Only the successful socket binder may publish identity, and publication must finish before health responds.
    server = await startObserverServer({
      socketPath,
      api,
      clock: systemClock,
      guardOperation: startupGate.assertReadyForOperation,
      logger,
    });
    ownsSocket = true;
    const boundIdentity = await readSocketIdentity(socketPath);
    if (boundIdentity === undefined) {
      throw new Error(`Could not capture the bound Observer socket identity at ${socketPath}.`);
    }
    boundSocketIdentity = boundIdentity;
    throwIfAborted(startupSignals.signal);
    processIdentity = createObserverProcessIdentity({
      pid: process.pid,
      processToken: options.processToken,
      version: buildVersion,
      socketPath,
    });
    await publishObserverProcessIdentity(processIdentity);
    throwIfAborted(startupSignals.signal);
    // Seed the watcher with the just-bound socket identity so it never adopts a
    // rival's socket as its baseline (the failure that let displaced observers linger).
    ownership = watchSocketOwnership({
      socketPath,
      expectedIdentity: boundIdentity,
      onLost: () => {
        ownsSocket = false;
        void logger.warn("Observer socket was taken over by another process; shutting down.", {
          socketPath,
          pid: process.pid,
        });
        // A displaced observer must not linger: its loops would keep draining
        // spool events and firing hooks for a state dir it no longer serves.
        // stopObserver's backstop guarantees the exit even if the drain hangs.
        void api.stop();
      },
    });
    // Current provider context is part of readiness; hook correlation must never see the empty seed.
    await api.reconcile("observer.startup");
    const startupCommit = startupGate.settleReady(() => claim.release());
    shouldReconcile = startupCommit.status === "ready";
    if (startupCommit.status === "ready") {
      notifyObserverStartupReady(deps.startupReadinessSink);
    }
    if (startupCommit.status === "ready" && startupCommit.claimRelease.status === "failed") {
      // Readiness is already committed; cleanup after a partial SQLite release
      // could race a successor, so the live Observer remains the socket owner.
      void logger
        .error("Observer boot claim could not be released cleanly after startup commitment.", {
          socketPath,
          error: startupCommit.claimRelease.error,
        })
        .catch(() => undefined);
    }
  } catch (error) {
    startupGate.settleFailed();
    shutdownExitCode = 1;
    await logger
      .error("Observer startup failed; shutting down runtime services.", {
        socketPath,
        error,
      })
      .catch(() => undefined);
    try {
      await stopObserver(1);
    } catch (shutdownError) {
      await logger
        .warn("Observer startup cleanup could not close every runtime service.", {
          socketPath,
          error: shutdownError,
        })
        .catch(() => undefined);
    } finally {
      try {
        sqlite.close();
      } catch {
        // Cleanup failure must not replace the original startup rejection.
      }
    }
    throw error;
  }
  if (shouldReconcile) {
    duplicateInspectionFlight = inspectObserverDuplicates(socketPath, {
      evidence: duplicateProcessEvidence,
      healthPid: async () => process.pid,
    }).catch((error) => {
      void logger.warn("Observer duplicate inspection failed unexpectedly.", {
        socketPath,
        error,
      });
      return {
        socketPath,
        duplicates: 0,
        targets: [],
        refusals: [{ pid: process.pid, reason: "Strict process evidence was unavailable." }],
      };
    });
    void duplicateInspectionFlight
      .then((plan) => logDuplicateInspection(logger, plan))
      .catch(() => undefined);
  }

  await stopped;
  sqlite.close();
  if (displaced) {
    // Node's natural handle cleanup closes Unix servers and can unlink a successor pathname.
    (deps.exit ?? process.exit)(shutdownExitCode);
  }
  // Stray unref-less timers must not keep a stopped observer alive.
  setTimeout(() => process.exit(0), 2000).unref();
  return 0;
}

function notifyObserverStartupReady(sink: ObserverStartupReadinessSink | undefined): void {
  try {
    sink?.ready();
  } catch {
    // Readiness is already committed; process-report transport failure cannot revoke it.
  }
}

async function logDuplicateInspection(
  logger: StationLogger,
  plan: ObserverReapPlan,
): Promise<void> {
  const eligiblePids = plan.targets
    .filter((target) => target.automaticEligibility.eligible)
    .map((target) => target.pid);
  const attributes: Record<string, unknown> = {
    socketPath: plan.socketPath,
    duplicates: plan.duplicates,
    eligiblePids,
    refusals: plan.refusals,
  };
  if (plan.duplicates === 0 && plan.refusals.length === 0) {
    await logger.info("Observer duplicate inspection clear.", attributes);
    return;
  }
  await logger.warn("Observer duplicate inspection requires operator review.", attributes);
}

function createConfiguredEventHooks(
  config: StationConfig,
  eventBus: ReturnType<typeof createObserverEventBus>,
  logger: ReturnType<typeof createObserverLogger>,
): ObserverEventHookRuntime | undefined {
  const hooks = config.hooks?.event ?? [];
  if (hooks.length === 0) {
    return undefined;
  }
  return createObserverEventHookRuntime({ hooks, eventBus, clock: systemClock, logger });
}

if (import.meta.main) {
  process.stderr.write(
    "apps/observer/dist/runtime/main.js is no longer a standalone production bootstrap. Use apps/cli/dist/observerMain.js.\n",
  );
  process.exitCode = 1;
}

function parseArgs(argv: string[]): {
  configPath?: string;
  socketPath?: string;
  stateDir?: string;
  startupTimeoutMs: number;
  buildVersion?: string;
  processToken: string;
} {
  const result: {
    configPath?: string;
    socketPath?: string;
    stateDir?: string;
    startupTimeoutMs: number;
    buildVersion?: string;
    processToken: string;
  } = { startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS, processToken: randomUUID() };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg?.startsWith("--") === true) {
      if (seen.has(arg)) throw new Error(`${arg} may be provided only once.`);
      seen.add(arg);
    }
    if (arg === "--config") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config requires a path.");
      }
      result.configPath = value;
      index += 1;
    } else if (arg === "--socket") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--socket requires a path.");
      }
      result.socketPath = value;
      index += 1;
    } else if (arg === "--state-dir") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--state-dir requires a path.");
      }
      result.stateDir = value;
      index += 1;
    } else if (arg === "--startup-timeout-ms") {
      if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
        throw new Error("--startup-timeout-ms must be a positive integer.");
      }
      const timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs)) {
        throw new Error("--startup-timeout-ms must be a positive safe integer.");
      }
      result.startupTimeoutMs = timeoutMs;
      index += 1;
    } else if (arg === "--build-version") {
      if (value === undefined || value.length === 0) {
        throw new Error("--build-version must be non-empty.");
      }
      result.buildVersion = value;
      index += 1;
    } else if (arg === "--process-token") {
      const processToken = ObserverProcessTokenSchema.safeParse(value);
      if (!processToken.success) {
        throw new Error("--process-token must be a UUID v4.");
      }
      result.processToken = processToken.data.toLowerCase();
      index += 1;
    } else {
      throw new Error(`Unknown Observer argument: ${arg ?? "<missing>"}`);
    }
  }
  return result;
}

function resolveObserverSocketPath(
  socketPath: string | undefined,
  config: StationConfig,
  stateDir: string,
  homeDir: string,
): string {
  if (socketPath !== undefined) {
    return resolvePath(socketPath, homeDir);
  }
  if (config.observer?.socketPath !== undefined) {
    return resolvePath(config.observer.socketPath, homeDir);
  }
  if (process.env.XDG_RUNTIME_DIR !== undefined && process.env.XDG_RUNTIME_DIR.length > 0) {
    return join(process.env.XDG_RUNTIME_DIR, "station", "observer.sock");
  }
  return join(stateDir, "run", "observer.sock");
}

function resolvePath(input: string, homeDir: string): string {
  const expanded =
    input === "~" ? homeDir : input.startsWith("~/") ? join(homeDir, input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

type ObserverStartupGate = {
  requestStop(): void;
  assertReadyForOperation(): void;
  settleReady(releaseClaim: () => ObserverBootClaimReleaseResult): ObserverStartupCommit;
  settleFailed(): void;
  waitUntilSettled(): Promise<void>;
  runHealth<T>(operation: () => Promise<T>): Promise<T>;
};

type ObserverStartupCommit =
  | { status: "stopped" }
  | { status: "ready"; claimRelease: ObserverBootClaimReleaseResult };

export function createObserverStartupGate(): ObserverStartupGate {
  let state: "starting" | "ready" | "stopping" | "failed" = "starting";
  let releaseHealth: () => void = () => undefined;
  let ready = pending();
  let settleStartup: () => void = () => undefined;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });

  function pending(): Promise<void> {
    return new Promise((resolve) => {
      releaseHealth = resolve;
    });
  }

  return {
    requestStop: () => {
      if (state === "stopping" || state === "failed") return;
      if (state === "ready") ready = pending();
      state = "stopping";
    },
    assertReadyForOperation: () => {
      if (state === "ready") return;
      throw {
        tag: "ObserverLifecycleError",
        code: state === "starting" ? "OBSERVER_NOT_READY" : "OBSERVER_STOPPING",
        message:
          state === "starting"
            ? "Observer is not ready to accept operations."
            : "Observer is stopping and cannot accept new operations.",
      } satisfies SafeError;
    },
    settleReady: (releaseClaim) => {
      if (state !== "starting") {
        settleStartup();
        return { status: "stopped" };
      }
      state = "ready";
      let claimRelease: ObserverBootClaimReleaseResult;
      try {
        // Ready is committed while the claim is held; health becomes visible
        // only after synchronous release lets the next child probe this socket.
        claimRelease = releaseClaim();
      } catch (error) {
        state = "failed";
        settleStartup();
        throw error;
      }
      releaseHealth();
      settleStartup();
      return { status: "ready", claimRelease };
    },
    settleFailed: () => {
      if (state === "starting") state = "failed";
      settleStartup();
    },
    waitUntilSettled: () => startupSettled,
    runHealth: async <T>(operation: () => Promise<T>): Promise<T> => {
      for (;;) {
        // pi-lens-ignore: await-in-loop
        await ready;
        if (state !== "ready") continue;
        const result = await operation();
        if (state === "ready") return result;
      }
    },
  };
}

function releaseObserverBootClaim(claim: AcquiredObserverBootClaim): void {
  const released = claim.release();
  if (released.status === "failed") {
    throw released.error;
  }
}

async function warnIdentityCleanupFailed(
  logger: StationLogger,
  socketPath: string,
  pid: number,
  error: unknown,
): Promise<void> {
  await logger
    .warn("Observer process identity could not be removed during shutdown.", {
      socketPath,
      pid,
      error: safeErrorFromUnknown(error, {
        tag: "ObserverLifecycleError",
        code: "OBSERVER_IDENTITY_REMOVE_FAILED",
        message: "Observer process identity could not be removed.",
      }),
    })
    .catch(() => undefined);
}
