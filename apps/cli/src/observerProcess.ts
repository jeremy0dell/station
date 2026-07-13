import { lstat } from "node:fs/promises";
import type { ObserverStopReceipt, SafeError } from "@station/contracts";
import { componentLogPath, createJsonlLogger, createTraceContext } from "@station/observability";
import { createObserverClient, isSocketStale } from "@station/protocol";
import {
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationBuildInfo,
  systemClock,
} from "@station/runtime";
import {
  classifyObserverHealth,
  defaultClientFactory,
  observerHandoffRefusedError,
} from "./observerProcess/health.js";
import { startObserverProcess } from "./observerProcess/startup.js";
import type {
  ObserverProcessDeps,
  ObserverProcessOptions,
  ObserverStatus,
} from "./observerProcess/types.js";
import { type ObserverPaths, resolveObserverPaths } from "./paths.js";

export { waitForObserverHealth } from "./observerProcess/health.js";
// Commands intentionally keep one stable lifecycle import while implementation lives in observerProcess/.
export type {
  ChildProcessLike,
  ObserverProcessDeps,
  ObserverProcessOptions,
  ObserverStatus,
  SpawnObserverInput,
} from "./observerProcess/types.js";

export async function getObserverStatus(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const socketExists = await socketPathExists(paths.socketPath);
  if (await isSocketStale(paths.socketPath)) {
    return { status: "stale", paths };
  }

  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs: observerStatusHealthTimeoutMs(options.timeoutMs),
    });
  try {
    return {
      status: "running",
      paths,
      health: await client.health(),
    };
  } catch (error) {
    const safeError = observerConnectionError(error, paths, socketExists);
    return {
      status: socketExists ? "unhealthy" : "stopped",
      paths,
      error: safeError,
    };
  }
}

/**
 * USE CASE
 *
 * Attaches to an exact or winning incumbent build, starts a child to negotiate
 * replacement of an older build, and refuses incomplete ownership evidence.
 * Socket ownership mutation remains inside the child's serialized boot lifecycle.
 */
export async function startObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clock = deps.clock ?? systemClock;
  const buildVersion = deps.buildVersion ?? stationBuildInfo().version;
  const trace = createTraceContext({ operation: "cli.observer.start" });
  const existing = await getObserverStatus({ ...options, paths }, deps);
  if (existing.status === "running") {
    const classification = classifyObserverHealth(existing.health, buildVersion);
    if (classification.action === "attach") {
      return existing;
    }
    if (classification.action === "refuse") {
      return {
        status: "unhealthy",
        paths,
        error: observerHandoffRefusedError(existing.health, buildVersion, classification.reason),
      };
    }
  }
  if (existing.status === "unhealthy") {
    return existing;
  }

  const result = await startObserverProcess(
    {
      paths,
      timeoutMs,
      trace,
      clock,
      buildVersion,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.onStartupProgress === undefined
        ? {}
        : { onStartupProgress: options.onStartupProgress }),
    },
    deps,
  );
  if (result.ok) {
    return {
      status: "running",
      paths,
      health: result.value,
    };
  }

  await logObserverLifecycleFailure({
    paths,
    operation: "cli.observer.start",
    trace,
    error: result.error,
    deps,
    clock,
  });
  return {
    status: "unhealthy",
    paths,
    error: result.error,
  };
}

export async function stopObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStopReceipt> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const client = (deps.clientFactory ?? defaultClientFactory)(paths.socketPath);
  const receipt = await client.stop();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const stopped = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "cli.observer.waitForStop",
      timeoutMs,
      error: {
        tag: "ObserverConnectionError",
        code: "OBSERVER_STOP_FAILED",
        message: "Observer did not stop cleanly.",
      },
      timeoutError: {
        tag: "ObserverConnectionError",
        code: "OBSERVER_STOP_TIMEOUT",
        message: "Observer did not stop before the timeout.",
      },
      retry: {
        retries: Math.max(1, Math.ceil(timeoutMs / 25)),
        delayMs: 25,
      },
    },
    async () => {
      const status = await getObserverStatus({ ...options, paths }, deps);
      if (status.status === "running") {
        throw new Error("observer still running");
      }
    },
  );
  if (!stopped.ok) {
    throw stopped.error;
  }
  return receipt;
}

export async function restartObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const status = await getObserverStatus(options, deps);
  if (status.status === "running") {
    await stopObserver({ ...options, paths: status.paths }, deps);
  }
  return startObserver({ ...options, paths: status.paths }, deps);
}

export function observerStatusErrorMessage(
  status: Exclude<ObserverStatus, { status: "running" }>,
): string {
  const error = status.error;
  if (error === undefined) {
    return "Observer is not running.";
  }

  const lines = [error.message];
  if (error.hint !== undefined) {
    lines.push(`Hint: ${error.hint}`);
  }
  if (error.code !== undefined) {
    lines.push(`Code: ${error.code}`);
  }
  return lines.join("\n");
}

export async function logObserverLifecycleFailure(input: {
  paths: ObserverPaths;
  operation: string;
  trace: RuntimeTraceContext;
  error: SafeError;
  deps: ObserverProcessDeps;
  clock: RuntimeClock;
}): Promise<void> {
  const logger =
    input.deps.logger ??
    createJsonlLogger({
      component: "cli",
      path: componentLogPath(input.paths.stateDir, "cli"),
      clock: input.clock,
    });
  try {
    await logger.log({
      level: "error",
      message: "Observer lifecycle failed.",
      ...(input.trace.traceId === undefined ? {} : { traceId: input.trace.traceId }),
      ...(input.trace.spanId === undefined ? {} : { spanId: input.trace.spanId }),
      attributes: {
        operation: input.operation,
        socketPath: input.paths.socketPath,
        stateDir: input.paths.stateDir,
        error: input.error,
      },
    });
  } catch {
    // The startup error itself must remain the user-visible result even if diagnostics logging fails.
  }
}

async function socketPathExists(socketPath: string): Promise<boolean> {
  try {
    await lstat(socketPath);
    return true;
  } catch {
    return false;
  }
}

function observerConnectionError(
  error: unknown,
  paths: ObserverPaths,
  socketExists: boolean,
): SafeError {
  const safeError = safeErrorFromUnknown(error, {
    tag: "ObserverConnectionError",
    code: "OBSERVER_NOT_RUNNING",
    message: "Observer is not running.",
  });
  if (!socketExists || safeError.code === "PROTOCOL_SCHEMA_MISMATCH") {
    return safeError;
  }

  if (safeError.tag === "TimeoutError" || safeError.code.endsWith("_TIMEOUT")) {
    const timeoutError: SafeError = {
      tag: "ObserverConnectionError",
      code: "OBSERVER_HEALTH_TIMEOUT",
      message: `Observer socket is present at ${paths.socketPath}, but the observer health request timed out.`,
      hint: `The observer may be busy, hung, or running incompatible code. Retry, check ${paths.stateDir}/logs/observer.jsonl, or restart the observer.`,
    };
    if (safeError.traceId !== undefined) timeoutError.traceId = safeError.traceId;
    if (safeError.diagnosticId !== undefined) timeoutError.diagnosticId = safeError.diagnosticId;
    return timeoutError;
  }

  const enhanced: SafeError = {
    tag: "ObserverConnectionError",
    code: "OBSERVER_SOCKET_UNHEALTHY",
    message: `Observer socket is present at ${paths.socketPath}, but the observer did not answer a valid health request.`,
    hint: "A stale, hung, or incompatible observer may own the socket. Stop that observer, remove the socket if no process owns it, or use a config with an isolated observer socket_path and state_dir.",
  };
  if (safeError.traceId !== undefined) enhanced.traceId = safeError.traceId;
  if (safeError.diagnosticId !== undefined) enhanced.diagnosticId = safeError.diagnosticId;
  return enhanced;
}

function observerStatusHealthTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? 2000, 5000);
}
