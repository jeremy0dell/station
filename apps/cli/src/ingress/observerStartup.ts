import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ObserverPaths } from "@station/config";
import type { ObserverHealth, SafeError } from "@station/contracts";
import { createObserverClient, isSocketStale } from "@station/protocol";
import {
  environmentWithoutGitLocals,
  type RuntimeClock,
  runRuntimeBoundaryWithRetryAndTimeout,
  runRuntimeBoundaryWithTimeout,
  safeErrorFromUnknown,
  systemClock,
} from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";

/**
 * An executable and fixed observer entry prefix forwarded unchanged until
 * startup appends observer socket, state, and config flags.
 */
export type ProviderHookObserverCommand = ExecutableArgv;

export type ProviderHookObserverStatus =
  | {
      status: "running";
      paths: ObserverPaths;
      health: ObserverHealth;
    }
  | {
      status: "stopped" | "stale" | "unhealthy";
      paths: ObserverPaths;
      error?: SafeError;
    };

export type ProviderHookObserverStartupDeps = {
  clientFactory?: (socketPath: string) => ReturnType<typeof createObserverClient>;
  spawnObserver?: (
    input: SpawnProviderHookObserverInput,
  ) => ChildProcessLike | Promise<ChildProcessLike>;
  clock?: RuntimeClock;
  sleep?: (ms: number) => Promise<void>;
};

export type SpawnProviderHookObserverInput = {
  paths: ObserverPaths;
  observerCommand?: ProviderHookObserverCommand;
  configPath?: string;
};

export type ChildProcessLike = Pick<ChildProcess, "pid" | "unref"> & {
  kill?: ChildProcess["kill"];
};

export type ProviderHookObserverStartupOptions = {
  configPath?: string;
  observerCommand?: ProviderHookObserverCommand;
  paths: ObserverPaths;
  timeoutMs?: number;
};

export async function getProviderHookObserverStatus(
  options: ProviderHookObserverStartupOptions,
  deps: ProviderHookObserverStartupDeps = {},
): Promise<ProviderHookObserverStatus> {
  const paths = options.paths;
  if (await isSocketStale(paths.socketPath)) {
    return { status: "stale", paths };
  }

  const client = (deps.clientFactory ?? defaultClientFactory)(paths.socketPath);
  try {
    return {
      status: "running",
      paths,
      health: await client.health(),
    };
  } catch (error) {
    return {
      status: "stopped",
      paths,
      error: safeErrorFromUnknown(error, {
        tag: "ObserverConnectionError",
        code: "OBSERVER_NOT_RUNNING",
        message: "Observer is not running.",
      }),
    };
  }
}

/**
 * USE CASE
 *
 * Attaches provider-hook delivery to a healthy Observer or starts a child while
 * leaving socket ownership mutation to the child's serialized boot lifecycle.
 */
export async function startProviderHookObserver(
  options: ProviderHookObserverStartupOptions,
  deps: ProviderHookObserverStartupDeps = {},
): Promise<ProviderHookObserverStatus> {
  const paths = options.paths;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clock = deps.clock ?? systemClock;
  const existing = await getProviderHookObserverStatus({ ...options, paths }, deps);
  if (existing.status === "running") {
    return existing;
  }
  let child: ChildProcessLike | undefined;
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "providerHooks.observer.start",
      clock,
      timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer startup failed.",
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer did not become healthy before the startup timeout.",
      },
    },
    async () => {
      await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
      const spawnInput: SpawnProviderHookObserverInput = { paths };
      if (options.observerCommand !== undefined) {
        spawnInput.observerCommand = options.observerCommand;
      }
      if (options.configPath !== undefined) {
        spawnInput.configPath = options.configPath;
      }
      child =
        deps.spawnObserver === undefined
          ? defaultSpawnObserver(spawnInput, timeoutMs)
          : await deps.spawnObserver(spawnInput);
      child.unref?.();
      return waitForProviderHookObserverHealth({ paths, timeoutMs }, deps);
    },
  );

  if (result.ok) {
    // A child queued on the boot claim must not outlive the incumbent this hook attached to.
    if (
      child?.pid !== undefined &&
      result.value.pid !== undefined &&
      child.pid !== result.value.pid
    ) {
      child.kill?.();
    }
    return {
      status: "running",
      paths,
      health: result.value,
    };
  }

  child?.kill?.();
  return {
    status: "unhealthy",
    paths,
    error: result.error,
  };
}

export async function waitForProviderHookObserverHealth(
  options: { paths: ObserverPaths; timeoutMs?: number },
  deps: ProviderHookObserverStartupDeps = {},
): Promise<ObserverHealth> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const client = (deps.clientFactory ?? defaultClientFactory)(options.paths.socketPath);
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "providerHooks.observer.waitForHealth",
      timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_HEALTH_FAILED",
        message: "Observer health check failed.",
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_HEALTH_TIMEOUT",
        message: "Observer did not report healthy before the timeout.",
      },
      retry: {
        retries: Math.max(1, Math.ceil(timeoutMs / 25)),
        delayMs: 25,
      },
    },
    async () => client.health(),
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function defaultClientFactory(socketPath: string) {
  return createObserverClient({ socketPath, timeoutMs: 500 });
}

function defaultSpawnObserver(
  input: SpawnProviderHookObserverInput,
  startupTimeoutMs: number,
): ChildProcessLike {
  if (input.observerCommand === undefined) {
    throw new Error("observerCommand is required to auto-start observer from provider hooks");
  }
  const [command, ...prefixArgs] = input.observerCommand;
  const args = [
    ...prefixArgs,
    "--socket",
    input.paths.socketPath,
    "--state-dir",
    input.paths.stateDir,
    ...(input.configPath === undefined ? [] : ["--config", input.configPath]),
    "--startup-timeout-ms",
    String(startupTimeoutMs),
  ];
  return spawn(command, args, {
    detached: true,
    env: environmentWithoutGitLocals(),
    stdio: "ignore",
  });
}
