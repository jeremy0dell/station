import type { ObserverHealth, SafeError } from "@station/contracts";
import { classifyObserverIncumbent } from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";
import {
  hasStationObserverBuildIdentityMarker,
  parseStationObserverBuildVersion,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  stationObserverBuildVersion,
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
  const buildVersion = options.buildVersion ?? deps.buildVersion ?? stationObserverBuildVersion();
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

/** Classifies health against the immutable Observer build selector of this CLI process. */
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
    hint: `Running build: ${formatObserverBuild(health.version)}. Requested build: ${formatObserverBuild(requestedVersion)}. ${reason} Run \`stn observer stop\` and retry when health reports stable process identity; otherwise use the matching checkout or an isolated Observer socket/state directory.`,
  };
}

export function observerHandoffPendingError(
  health: ObserverHealth,
  requestedVersion: string,
): SafeError {
  return {
    tag: "ObserverStartupError",
    code: "OBSERVER_HANDOFF_PENDING",
    message: `Observer build ${formatObserverBuild(requestedVersion)} is waiting to replace build ${formatObserverBuild(health.version)}.`,
  };
}

function formatObserverBuild(buildVersion: string | undefined): string {
  if (buildVersion === undefined) return "unknown (legacy identity)";
  const parsed = parseStationObserverBuildVersion(buildVersion);
  if (parsed.buildIdentity === undefined && hasStationObserverBuildIdentityMarker(buildVersion)) {
    return `${parsed.version} (invalid build identity)`;
  }
  return parsed.buildIdentity === undefined
    ? `${parsed.version} (legacy identity)`
    : `${parsed.version} (build ${parsed.buildIdentity.slice(0, 12)})`;
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
