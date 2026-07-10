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
import { createObserverPersistence } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { createObserverCore, providerProjectsFromConfig } from "../reconcile/core.js";
import { openObserverSqlite } from "../sqlite.js";
import { createObserverApi } from "./api.js";
import { createObserverEventBus } from "./eventBus.js";
import { runShutdownWithBackstop } from "./gracefulExit.js";
import { createObserverLogger } from "./logging.js";
import { type ObserverServer, startObserverServer } from "./server.js";
import {
  readSocketIdentity,
  type SocketOwnershipWatch,
  watchSocketOwnership,
} from "./socketOwnership.js";

// Ceiling on a graceful stop; a wedged drain (a handler ignoring its abort)
// force-exits at this point instead of keeping the observer alive forever.
const STOP_BACKSTOP_MS = 5000;

export type ObserverProviderRegistryFactoryOptions = {
  configPath?: string | undefined;
};

export type ObserverProviderRegistryFactory = (
  config: StationConfig,
  options: ObserverProviderRegistryFactoryOptions,
) => ProviderRegistry;

export type RunObserverMainDeps = {
  providerRegistryFactory: ObserverProviderRegistryFactory;
};

/**
 * COMPOSITION ROOT
 *
 * Builds the process-lifetime Observer runtime around provider adapters
 * supplied by CLI composition.
 *
 * Shutdown owns the command queue, event hook, server, and SQLite lifecycles
 * created here.
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

  const sqlite = openObserverSqlite({
    path: join(stateDir, "observer.sqlite"),
    clock: systemClock,
  });
  const persistence = createObserverPersistence({ sqlite, clock: systemClock });
  const eventBus = createObserverEventBus();
  const logger = createObserverLogger({ stateDir, clock: systemClock });
  const pruneAt = toIsoTimestamp(systemClock.now());
  await persistence.pruneExpiredProviderObservations(pruneAt);
  const commandQueue = createCommandQueue({ persistence, clock: systemClock, eventBus, logger });
  const providerOptions: ObserverProviderRegistryFactoryOptions = {};
  if (options.configPath !== undefined) {
    providerOptions.configPath = loadedConfig.configPath;
  }
  const providers = deps.providerRegistryFactory(config, providerOptions);
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
    sqlite,
    clock: systemClock,
    logger,
    featureFlags,
    version: stationBuildInfo().version,
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
  let stopResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let stopping: Promise<void> | undefined;
  const stopObserver = async () => {
    stopping ??= runShutdownWithBackstop(
      async () => {
        ownership?.stop();
        await commandQueue.shutdown();
        await eventHooks?.shutdown();
        await server?.close();
        stopResolve();
      },
      STOP_BACKSTOP_MS,
      {
        exit: (code) => process.exit(code),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      },
    );
    await stopping;
  };
  const api = createObserverApi({
    core,
    providers,
    persistence,
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
    onStop: () => {
      setTimeout(() => {
        void stopObserver();
      }, 0);
    },
  });

  try {
    // Bind only; the startup reconcile runs below, after the ownership watch is
    // armed, so a takeover during that ~1s scan is detected rather than missed.
    server = await startObserverServer({
      socketPath,
      api,
      clock: systemClock,
      drainOnStart: false,
    });
  } catch (error) {
    await logger.error("Observer server could not start; shutting down runtime services.", {
      socketPath,
      error,
    });
    // Services started before the bind (command queue, event hooks) hold live
    // timers; without teardown + forced exit a failed-bind observer lingers as
    // a spool-stealing zombie that never owned the socket.
    await stopObserver();
    sqlite.close();
    setTimeout(() => process.exit(1), 2000).unref();
    return 1;
  }
  // Seed the watcher with the just-bound socket identity so it never adopts a
  // rival's socket as its baseline (the failure that let displaced observers linger).
  const boundIdentity = await readSocketIdentity(socketPath);
  ownership = watchSocketOwnership({
    socketPath,
    ...(boundIdentity === undefined ? {} : { expectedIdentity: boundIdentity }),
    onLost: () => {
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
  const stopFromSignal = () => {
    void api.stop();
  };
  process.once("SIGINT", stopFromSignal);
  process.once("SIGTERM", stopFromSignal);

  // Startup reconcile now that the ownership watch is live.
  await api.reconcile("observer.startup");

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
