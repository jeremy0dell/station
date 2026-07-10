import type { ObserverHealth, SafeError } from "@station/contracts";
import { createObserverClient } from "@station/protocol";
import { type RuntimeTraceContext, runRuntimeBoundaryWithRetryAndTimeout } from "@station/runtime";
import type { ObserverProcessDeps, SpawnObserverInput } from "./types.js";

export function defaultClientFactory(socketPath: string) {
  return createObserverClient({ socketPath, timeoutMs: 500 });
}

export async function waitForObserverHealth(
  options: {
    paths: SpawnObserverInput["paths"];
    timeoutMs?: number;
    trace?: RuntimeTraceContext;
    signal?: AbortSignal;
  },
  deps: ObserverProcessDeps = {},
): Promise<ObserverHealth> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const retries = Math.max(1, Math.ceil(timeoutMs / 25));
  const client = (deps.clientFactory ?? defaultClientFactory)(options.paths.socketPath);
  const result = await runRuntimeBoundaryWithRetryAndTimeout(
    observerHealthBoundaryOptions(timeoutMs, retries, options.trace),
    ({ signal }) => requestObserverHealth(() => client.health(), [signal, options.signal]),
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value;
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
      delayMs: 25,
      shouldRetry: (error, attempt) =>
        error.code !== "OBSERVER_HEALTH_WAIT_CANCELLED" && attempt < retries,
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
