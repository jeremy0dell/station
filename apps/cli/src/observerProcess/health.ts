import type { ObserverHealth, SafeError } from "@station/contracts";
import { classifyObserverIncumbent } from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import {
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  stationBuildInfo,
} from "@station/runtime";
import type { ObserverProcessDeps, SpawnObserverInput } from "./types.js";

const millisecondsPerSecond = 1000;
const defaultObserverHealthTimeoutMs = 2000;
const observerHealthRetryIntervalMs = 25;
const defaultObserverClientTimeoutMs = 500;
const processStartedAt = new Date(
  Date.now() - process.uptime() * millisecondsPerSecond,
).toISOString();

export type ObserverBuildClassification = ReturnType<typeof classifyObserverIncumbent>;

export function defaultClientFactory(socketPath: string) {
  return createObserverClient({ socketPath, timeoutMs: defaultObserverClientTimeoutMs });
}

export async function waitForObserverHealth(
  options: {
    paths: SpawnObserverInput["paths"];
    timeoutMs?: number;
    buildVersion?: string;
    trace?: RuntimeTraceContext;
    signal?: AbortSignal;
    onBuildClassification?: (
      classification: ObserverBuildClassification,
      health: ObserverHealth,
    ) => void;
  },
  deps: ObserverProcessDeps = {},
): Promise<ObserverHealth> {
  const timeoutMs = options.timeoutMs ?? defaultObserverHealthTimeoutMs;
  const buildVersion = options.buildVersion ?? deps.buildVersion ?? stationBuildInfo().version;
  const retries = Math.max(1, Math.ceil(timeoutMs / observerHealthRetryIntervalMs));
  const client = (deps.clientFactory ?? defaultClientFactory)(options.paths.socketPath);
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    observerHealthBoundaryOptions(timeoutMs, retries, options.trace),
    async ({ signal }) => {
      const health = await requestObserverHealth(() => client.health(), [signal, options.signal]);
      const classification = classifyObserverHealth(health, buildVersion);
      options.onBuildClassification?.(classification, health);
      if (classification.action === "attach") {
        return health;
      }
      if (classification.action === "refuse") {
        throw observerHandoffRefusedError(health, buildVersion, classification.reason);
      }
      throw observerHandoffPendingError(health, buildVersion);
    },
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Classifies one health response against the stable identity of this CLI process. */
export function classifyObserverHealth(
  health: ObserverHealth,
  buildVersion: string,
): ObserverBuildClassification {
  return classifyObserverIncumbent({
    candidate: {
      version: buildVersion,
      startedAt: processStartedAt,
      pid: process.pid,
    },
    incumbent: health,
  });
}

export function observerHandoffRefusedError(
  health: ObserverHealth,
  requestedVersion: string,
  reason: string,
): SafeError {
  return {
    tag: "ObserverStartupError",
    code: "OBSERVER_HANDOFF_REFUSED",
    message: "Observer build handoff was refused because ownership could not be changed safely.",
    hint: `Running build: ${health.version ?? "unknown"}. Requested build: ${requestedVersion}. ${reason} Use an isolated observer socket/state directory or stop the incumbent explicitly.`,
  };
}

export function observerHandoffPendingError(
  health: ObserverHealth,
  requestedVersion: string,
): SafeError {
  return {
    tag: "ObserverStartupError",
    code: "OBSERVER_HANDOFF_PENDING",
    message: `Observer build ${requestedVersion} is waiting to replace build ${health.version ?? "unknown"}.`,
  };
}

function abortableObserverHealth(
  health: Promise<ObserverHealth>,
  signals: readonly AbortSignal[],
): Promise<ObserverHealth> {
  if (signals.some((signal) => signal.aborted)) {
    void health.catch(() => undefined);
    return Promise.reject(observerHealthWaitCancelledError());
  }

  return new Promise<ObserverHealth>((resolve, reject) => {
    const cleanup = () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const onAbort = () => {
      cleanup();
      reject(observerHealthWaitCancelledError());
    };
    for (const signal of signals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void health.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function observerHealthWaitCancelledError(): SafeError {
  return {
    tag: "CancellationError",
    code: "OBSERVER_HEALTH_WAIT_CANCELLED",
    message: "Observer health wait was cancelled.",
  };
}

function isAbortSignal(value: AbortSignal | undefined): value is AbortSignal {
  return value !== undefined;
}

function observerHealthBoundaryOptions(
  timeoutMs: number,
  retries: number,
  trace: RuntimeTraceContext | undefined,
): Parameters<typeof runRuntimeBoundaryWithRetryAndTimeout>[0] {
  const traceFields =
    trace?.traceId === undefined
      ? {}
      : {
          hint: `Run station debug trace ${trace.traceId}.`,
          traceId: trace.traceId,
        };
  return {
    operation: "cli.observer.waitForHealth",
    timeoutMs,
    error: {
      tag: "ObserverStartupError",
      code: "OBSERVER_HEALTH_FAILED",
      message: "Observer health check failed.",
      ...traceFields,
    },
    timeoutError: {
      tag: "ObserverStartupError",
      code: "OBSERVER_HEALTH_TIMEOUT",
      message: "Observer did not report healthy before the timeout.",
      ...traceFields,
    },
    retry: {
      retries,
      delayMs: observerHealthRetryIntervalMs,
      shouldRetry: (error, attempt) =>
        error.code !== "OBSERVER_HEALTH_WAIT_CANCELLED" &&
        error.code !== "OBSERVER_HANDOFF_REFUSED" &&
        attempt < retries,
    },
    trace,
  };
}

function requestObserverHealth(
  health: () => Promise<ObserverHealth>,
  candidates: readonly (AbortSignal | undefined)[],
): Promise<ObserverHealth> {
  const signals = candidates.filter(isAbortSignal);
  if (signals.some((candidate) => candidate.aborted)) {
    return Promise.reject(observerHealthWaitCancelledError());
  }
  return abortableObserverHealth(health(), signals);
}
