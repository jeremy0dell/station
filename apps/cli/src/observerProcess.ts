import type { ObserverHealth, ObserverStopReceipt, SafeError } from "@station/contracts";
import { componentLogPath, createJsonlLogger, createTraceContext } from "@station/observability";
import {
  createObserverClient,
  type ExpectedObserverIdentity,
  probeUnixSocket,
} from "@station/protocol";
import {
  parseStationObserverBuildVersion,
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationObserverBuildVersion,
  systemClock,
} from "@station/runtime";
import { classifyObserverHealth, observerHandoffRefusedError } from "./observerProcess/health.js";
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

/**
 * USE CASE
 *
 * Reports inaccessible socket ownership without spawning, unlinking, stopping,
 * or signaling another process.
 */
export async function getObserverStatus(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const probe = await probeUnixSocket(paths.socketPath);
  if (probe.status === "stale") {
    return { status: "stale", paths };
  }
  if (probe.status === "inaccessible") {
    return { status: "unhealthy", paths, error: observerSocketInaccessibleError(paths.socketPath) };
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
    const socketExists = probe.status === "listening";
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
  const buildVersion = deps.buildVersion ?? stationObserverBuildVersion();
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

/**
 * USE CASE
 *
 * Stops only the exact Observer process attributed by the initial health response.
 */
export async function stopObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStopReceipt> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const status = await getObserverStatus({ ...options, paths }, deps);
  if (status.status !== "running") {
    throw (
      status.error ?? {
        tag: "ObserverConnectionError",
        code: "OBSERVER_NOT_RUNNING",
        message: "Observer is not running.",
      }
    );
  }
  return stopRunningObserver(status, options, deps);
}

async function stopRunningObserver(
  status: Extract<ObserverStatus, { status: "running" }>,
  options: ObserverProcessOptions,
  deps: ObserverProcessDeps,
): Promise<ObserverStopReceipt> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadlineMs = Date.now() + timeoutMs;
  const expectedObserverIdentity = requireExpectedObserverIdentity(status);
  const requestTimeoutMs = remainingStopTimeoutMs(deadlineMs);
  if (requestTimeoutMs <= 0) throw observerStopTimeoutError();
  const client =
    deps.clientFactory?.(status.paths.socketPath, {
      expectedObserverIdentity,
      timeoutMs: requestTimeoutMs,
    }) ??
    createObserverClient({
      socketPath: status.paths.socketPath,
      timeoutMs: requestTimeoutMs,
      expectedObserverIdentity,
    });
  const receipt = await client.stop();
  const convergenceTimeoutMs = remainingStopTimeoutMs(deadlineMs);
  if (convergenceTimeoutMs <= 0) throw observerStopTimeoutError();
  const retries = Math.max(1, Math.ceil(convergenceTimeoutMs / 25));
  const stopped = await runRuntimeBoundaryWithRetryAndTimeout(
    {
      operation: "cli.observer.waitForStop",
      timeoutMs: convergenceTimeoutMs,
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
        retries,
        delayMs: 25,
        shouldRetry: (error, attempt) =>
          error.code !== "OBSERVER_STOP_TIMEOUT" && attempt < retries,
      },
    },
    async () => {
      const remainingMs = remainingStopTimeoutMs(deadlineMs);
      if (remainingMs <= 0) throw observerStopTimeoutError();
      const current = await getObserverStatus(
        { ...options, paths: status.paths, timeoutMs: remainingMs },
        deps,
      );
      if (current.status !== "stopped" && current.status !== "stale") {
        throw new Error("observer endpoint still live");
      }
    },
  );
  if (!stopped.ok) {
    throw stopped.error;
  }
  return receipt;
}

function remainingStopTimeoutMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

function observerStopTimeoutError(): SafeError {
  return {
    tag: "ObserverConnectionError",
    code: "OBSERVER_STOP_TIMEOUT",
    message: "Observer did not stop before the timeout.",
  };
}

function requireExpectedObserverIdentity(
  status: Extract<ObserverStatus, { status: "running" }>,
): ExpectedObserverIdentity {
  const identity = expectedObserverIdentity(status);
  if (identity !== undefined) return identity;
  throw {
    tag: "ObserverConnectionError",
    code: "OBSERVER_STOP_FAILED",
    message: "Observer stop requires stable process identity from health.",
    hint: "The Observer must report a PID and start time before Station can stop that exact process safely.",
  } satisfies SafeError;
}

function expectedObserverIdentity(
  status: Extract<ObserverStatus, { status: "running" }>,
): ExpectedObserverIdentity | undefined {
  const { health, paths } = status;
  if (
    health.pid === undefined ||
    health.startedAt === undefined ||
    (health.socketPath !== undefined && health.socketPath !== paths.socketPath)
  ) {
    return undefined;
  }
  const identity: ExpectedObserverIdentity = {
    pid: health.pid,
    startedAt: health.startedAt,
    socketPath: paths.socketPath,
  };
  if (health.version !== undefined) identity.version = health.version;
  return identity;
}

function hasLegacyObserverBuildIdentity(health: ObserverHealth): boolean {
  return (
    health.version === undefined ||
    parseStationObserverBuildVersion(health.version).buildIdentity === undefined
  );
}

/**
 * USE CASE
 *
 * Restarts an exact or replaceable incumbent without stopping a newer winning build.
 */
export async function restartObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const status = await getObserverStatus(options, deps);
  if (status.status === "running") {
    const buildVersion = deps.buildVersion ?? stationObserverBuildVersion();
    const classification = classifyObserverHealth(status.health, buildVersion);
    if (classification.action === "attach" && classification.reason === "incumbent-wins") {
      return {
        status: "unhealthy",
        paths: status.paths,
        error: observerHandoffRefusedError(
          status.health,
          buildVersion,
          "A lower-build caller cannot restart a newer Observer or activate configuration in it.",
        ),
      };
    }
    if (
      classification.action === "refuse" &&
      hasLegacyObserverBuildIdentity(status.health) &&
      expectedObserverIdentity(status) !== undefined
    ) {
      // Explicit restart is the recovery path for a legacy build only when its process stays pinned.
      await stopRunningObserver(status, options, deps);
    } else if (classification.action === "refuse") {
      return {
        status: "unhealthy",
        paths: status.paths,
        error: observerHandoffRefusedError(status.health, buildVersion, classification.reason),
      };
    } else if (classification.reason === "exact-build") {
      await stopRunningObserver(status, options, deps);
    }
  }
  if (status.status === "unhealthy") return status;
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

function observerSocketInaccessibleError(socketPath: string): SafeError {
  return {
    tag: "ObserverSocketError",
    code: "OBSERVER_SOCKET_INACCESSIBLE",
    message: "The Observer socket exists but cannot be reached or proven safe to reclaim.",
    hint: `Restore access to ${socketPath}, normally mode 0600; inspect it with lsof, or use an isolated socket and state directory. Do not unlink it or trust its pidfile as liveness proof.`,
  };
}

function observerStatusHealthTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? 2000, 5000);
}
