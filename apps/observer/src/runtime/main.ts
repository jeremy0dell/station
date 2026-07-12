#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  emptyConfig,
  type LoadedStationConfig,
  loadConfig,
  type StationConfig,
} from "@station/config";
import type { ObserverApi, ObserverProcessIdentity, ObserverStopReceipt } from "@station/contracts";
import { componentLogPath } from "@station/observability";
import { stationBuildInfo, systemClock, toIsoTimestamp } from "@station/runtime";
import { createCommandQueue } from "../commands/queue.js";
import { registerObserverCommandHandlers } from "../commands/router.js";
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
import { createObserverApi } from "./api.js";
import { createObserverEventBus } from "./eventBus.js";
import { runShutdownWithBackstop } from "./gracefulExit.js";
import { createObserverLogger } from "./logging.js";
import {
  createObserverProcessIdentity,
  publishObserverProcessIdentity,
  removeObserverProcessIdentity,
} from "./observerPidfile.js";
import { type ObserverServer, startObserverServer } from "./server.js";
import {
  readSocketIdentity,
  type SocketIdentity,
  type SocketOwnershipWatch,
  watchSocketOwnership,
} from "./socketOwnership.js";

// Ceiling on a graceful stop; a wedged drain (a handler ignoring its abort)
// force-exits at this point instead of keeping the observer alive forever.
const STOP_BACKSTOP_MS = 5000;

export type ObserverProviderRegistryFactoryOptions = {
  stateDir: string;
  configPath?: string | undefined;
};

export type ObserverProviderRegistryFactory = (
  config: StationConfig,
  options: ObserverProviderRegistryFactoryOptions,
) => ProviderRegistry | Promise<ProviderRegistry>;

export type RunObserverMainDeps = {
  providerRegistryFactory: ObserverProviderRegistryFactory;
};

/**
 * COMPOSITION ROOT
 *
 * Builds the process-lifetime Observer runtime around provider adapters
 * supplied by awaited CLI composition, including socket identity publication,
 * health readiness, and shutdown of the services created here.
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
  const spoolDir = providerIngressSpoolDir(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const providerOptions: ObserverProviderRegistryFactoryOptions = { stateDir };
  if (options.configPath !== undefined) {
    providerOptions.configPath = loadedConfig.configPath;
  }
  const providers = await deps.providerRegistryFactory(config, providerOptions);

  const sqlite = openObserverSqlite({
    path: join(stateDir, "observer.sqlite"),
    clock: systemClock,
  });
  const persistence = createSqliteObserverPersistence({ sqlite, clock: systemClock });
  const eventBus = createObserverEventBus();
  const logger = createObserverLogger({ stateDir, clock: systemClock });
  const buildVersion = stationBuildInfo().version;
  const pruneAt = toIsoTimestamp(systemClock.now());
  await persistence.pruneExpiredProviderObservations(pruneAt);
  const commandQueue = createCommandQueue({ persistence, clock: systemClock, eventBus, logger });
  // Fire-and-forget boot probes: snapshots read cached results and fill in as they land.
  void providers.refreshHarnessVersions();
  void providers.healthCache.refreshAll();
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
    version: buildVersion,
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
    ...(options.configPath === undefined ? {} : { configPath: loadedConfig.configPath }),
  });
  const eventHooks = createConfiguredEventHooks(config, eventBus, logger);

  let server: ObserverServer | undefined;
  let ownership: SocketOwnershipWatch | undefined;
  let ownsSocket = false;
  let boundSocketIdentity: SocketIdentity | undefined;
  let processIdentity: ObserverProcessIdentity | undefined;
  const startupGate = createObserverStartupGate();
  let stopResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopping: Promise<void> | undefined;
  let stopReceipt: Promise<ObserverStopReceipt> | undefined;
  let observerApi: ObserverApi;
  let shutdownExitCode = 0;
  const stopObserver = async (exitCode = 0) => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    stopping ??= runShutdownWithBackstop(
      async () => {
        let shutdownError: unknown;
        stopReceipt ??= (async () => {
          // Publication must settle before cleanup so a pre-ready stop cannot leave a late pidfile behind.
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
            await logger
              .warn("Observer process identity could not be removed during shutdown.", {
                socketPath,
                pid: processIdentity.pid,
                error,
              })
              .catch(() => undefined);
          }
        }
        ownership?.stop();
        try {
          await server?.close();
        } catch (error) {
          shutdownError ??= error;
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
    eventBus,
    hookSpoolDir: spoolDir,
    socketPath,
    stateDir,
    diagnosticsDir: join(stateDir, "diagnostics"),
    logPaths: [logger.path, componentLogPath(stateDir, "hook")],
    config,
    ...(options.configPath === undefined ? {} : { configPath: loadedConfig.configPath }),
    configDiagnostics: loadedConfig.diagnostics,
    clock: systemClock,
    logger,
  });
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

  let shouldReconcile = false;
  try {
    // Only the successful socket binder may publish identity, and publication must finish before health responds.
    server = await startObserverServer({
      socketPath,
      api,
      clock: systemClock,
      drainOnStart: false,
    });
    ownsSocket = true;
    const boundIdentity = await readSocketIdentity(socketPath);
    if (boundIdentity === undefined) {
      throw new Error(`Could not capture the bound Observer socket identity at ${socketPath}.`);
    }
    boundSocketIdentity = boundIdentity;
    processIdentity = createObserverProcessIdentity({
      pid: process.pid,
      version: buildVersion,
      socketPath,
    });
    await publishObserverProcessIdentity(processIdentity);
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
    shouldReconcile = startupGate.settleReady();
  } catch (error) {
    startupGate.settleFailed();
    shutdownExitCode = 1;
    await logger.error("Observer startup failed; shutting down runtime services.", {
      socketPath,
      error,
    });
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
      sqlite.close();
    }
    setTimeout(() => process.exit(1), 2000).unref();
    return 1;
  }
  if (shouldReconcile) {
    const stopFromSignal = () => {
      void api.stop();
    };
    process.once("SIGINT", stopFromSignal);
    process.once("SIGTERM", stopFromSignal);

    // Startup reconcile now that the ownership watch is live.
    await api.reconcile("observer.startup");
  }

  await stopped;
  sqlite.close();
  // Stray unref-less timers must not keep a stopped observer alive.
  setTimeout(() => process.exit(0), 2000).unref();
  return 0;
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
} {
  const result: {
    configPath?: string;
    socketPath?: string;
    stateDir?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value !== undefined) {
      result.configPath = value;
      index += 1;
    } else if (arg === "--socket" && value !== undefined) {
      result.socketPath = value;
      index += 1;
    } else if (arg === "--state-dir" && value !== undefined) {
      result.stateDir = value;
      index += 1;
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
  settleReady(): boolean;
  settleFailed(): void;
  waitUntilSettled(): Promise<void>;
  runHealth<T>(operation: () => Promise<T>): Promise<T>;
};

export function createObserverStartupGate(): ObserverStartupGate {
  let state: "starting" | "ready" | "stopping" | "failed" = "starting";
  let release: () => void = () => undefined;
  let ready = pending();
  let settleStartup: () => void = () => undefined;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });

  function pending(): Promise<void> {
    return new Promise((resolve) => {
      release = resolve;
    });
  }

  return {
    requestStop: () => {
      if (state === "stopping" || state === "failed") return;
      if (state === "ready") ready = pending();
      state = "stopping";
    },
    settleReady: () => {
      if (state !== "starting") {
        settleStartup();
        return false;
      }
      state = "ready";
      release();
      settleStartup();
      return true;
    },
    settleFailed: () => {
      if (state === "starting") state = "failed";
      settleStartup();
    },
    waitUntilSettled: () => startupSettled,
    runHealth: async <T>(operation: () => Promise<T>): Promise<T> => {
      for (;;) {
        await ready;
        if (state !== "ready") continue;
        const result = await operation();
        if (state === "ready") return result;
      }
    },
  };
}
