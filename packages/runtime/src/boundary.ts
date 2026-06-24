import { Effect } from "./effect.js";
import {
  type RuntimeSafeError,
  type RuntimeSafeErrorFallback,
  safeErrorFromUnknown,
} from "./errors.js";

export type RuntimeClock = {
  now(): Date;
};

export type RuntimeTraceContext = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  operation?: string | undefined;
};

export type RuntimeBoundaryExecutionContext = {
  signal: AbortSignal;
};

export type RuntimeBoundaryTask<T> = (context: RuntimeBoundaryExecutionContext) => Promise<T>;

export type RuntimeBoundaryTiming = {
  operation: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type RuntimeBoundaryResult<T> =
  | {
      ok: true;
      value: T;
      timing: RuntimeBoundaryTiming;
      traceId?: string;
      spanId?: string;
    }
  | {
      ok: false;
      error: RuntimeSafeError;
      timing: RuntimeBoundaryTiming;
      traceId?: string;
      spanId?: string;
    };

export type RuntimeTimeoutOptions = {
  timeoutMs: number;
  error: RuntimeSafeErrorFallback;
  timeoutError?: RuntimeSafeErrorFallback | undefined;
};

export type RuntimeRetryOptions = {
  retries: number;
  delayMs?: number;
  shouldRetry?: (error: RuntimeSafeError, attempt: number) => boolean;
};

export const systemClock: RuntimeClock = {
  now: () => new Date(),
};

export function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function durationMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

export function runtimeBoundaryEffect<T>(
  input: {
    error: RuntimeSafeErrorFallback;
  },
  task: RuntimeBoundaryTask<T>,
): Effect.Effect<T, RuntimeSafeError> {
  return Effect.tryPromise({
    try: (signal) => task({ signal }),
    catch: (error) => safeErrorFromUnknown(error, input.error),
  });
}

export async function runRuntimeBoundary<T>(
  input: {
    operation: string;
    clock?: RuntimeClock | undefined;
    error: RuntimeSafeErrorFallback;
    trace?: RuntimeTraceContext | undefined;
  },
  task: RuntimeBoundaryTask<T>,
): Promise<RuntimeBoundaryResult<T>> {
  const clock = input.clock ?? systemClock;
  const startedAt = toIsoTimestamp(clock.now());
  return finishRuntimeBoundary(input, startedAt, runtimeBoundaryEffect(input, task));
}

export function runtimeBoundaryWithTimeoutEffect<T>(
  input: RuntimeTimeoutOptions,
  task: RuntimeBoundaryTask<T>,
): Effect.Effect<T, RuntimeSafeError> {
  return Effect.timeoutFail(runtimeBoundaryEffect(input, task), {
    duration: `${input.timeoutMs} millis`,
    onTimeout: () =>
      safeErrorFromUnknown(input.timeoutError ?? input.error, input.timeoutError ?? input.error),
  });
}

export async function runRuntimeBoundaryWithTimeout<T>(
  input: {
    operation: string;
    clock?: RuntimeClock | undefined;
    timeoutMs: number;
    error: RuntimeSafeErrorFallback;
    timeoutError?: RuntimeSafeErrorFallback | undefined;
    trace?: RuntimeTraceContext | undefined;
  },
  task: RuntimeBoundaryTask<T>,
): Promise<RuntimeBoundaryResult<T>> {
  const clock = input.clock ?? systemClock;
  const startedAt = toIsoTimestamp(clock.now());
  return finishRuntimeBoundary(input, startedAt, runtimeBoundaryWithTimeoutEffect(input, task));
}

export async function runRuntimeBoundaryWithRetry<T>(
  input: {
    operation: string;
    clock?: RuntimeClock | undefined;
    error: RuntimeSafeErrorFallback;
    retry: RuntimeRetryOptions;
    trace?: RuntimeTraceContext | undefined;
  },
  task: RuntimeBoundaryTask<T>,
): Promise<RuntimeBoundaryResult<T>> {
  const clock = input.clock ?? systemClock;
  const startedAt = toIsoTimestamp(clock.now());
  return finishRuntimeBoundary(
    input,
    startedAt,
    runtimeBoundaryWithRetryEffect(input.retry, input.error, task),
  );
}

export async function runRuntimeBoundaryWithRetryAndTimeout<T>(
  input: {
    operation: string;
    clock?: RuntimeClock | undefined;
    timeoutMs: number;
    error: RuntimeSafeErrorFallback;
    timeoutError?: RuntimeSafeErrorFallback | undefined;
    retry: RuntimeRetryOptions;
    trace?: RuntimeTraceContext | undefined;
  },
  task: RuntimeBoundaryTask<T>,
): Promise<RuntimeBoundaryResult<T>> {
  const clock = input.clock ?? systemClock;
  const startedAt = toIsoTimestamp(clock.now());
  // attempt is an Effect description, so each retry re-runs the task with its own timeout.
  const attempt = runtimeBoundaryWithTimeoutEffect(input, task);
  return finishRuntimeBoundary(input, startedAt, retryEffect(attempt, input.retry));
}

export function runtimeBoundaryWithRetryEffect<T>(
  retry: RuntimeRetryOptions,
  fallback: RuntimeSafeErrorFallback,
  task: RuntimeBoundaryTask<T>,
): Effect.Effect<T, RuntimeSafeError> {
  return retryEffect(runtimeBoundaryEffect({ error: fallback }, task), retry);
}

export async function withRetry<T>(
  retry: RuntimeRetryOptions,
  fallback: RuntimeSafeErrorFallback,
  task: RuntimeBoundaryTask<T>,
): Promise<T> {
  return Effect.runPromise(runtimeBoundaryWithRetryEffect(retry, fallback, task));
}

export async function withTimeout<T>(
  task: RuntimeBoundaryTask<T>,
  input: RuntimeTimeoutOptions,
): Promise<T> {
  return Effect.runPromise(runtimeBoundaryWithTimeoutEffect(input, task));
}

async function finishRuntimeBoundary<T>(
  input: {
    operation: string;
    clock?: RuntimeClock | undefined;
    trace?: RuntimeTraceContext | undefined;
  },
  startedAt: string,
  effect: Effect.Effect<T, RuntimeSafeError>,
): Promise<RuntimeBoundaryResult<T>> {
  const clock = input.clock ?? systemClock;
  const result = await Effect.runPromise(
    Effect.catchAll(
      Effect.map(effect, (value) => ({
        ok: true as const,
        value,
      })),
      (error) =>
        Effect.succeed({
          ok: false as const,
          error: withTrace(error, input.trace),
        }),
    ),
  );
  const finishedAt = toIsoTimestamp(clock.now());
  const timing = {
    operation: input.operation,
    startedAt,
    finishedAt,
    durationMs: durationMs(startedAt, finishedAt),
  };
  const traceFields = traceFieldsFromContext(input.trace);

  if (result.ok) {
    return {
      ok: true,
      value: result.value,
      timing,
      ...traceFields,
    };
  }

  return {
    ok: false,
    error: result.error,
    timing,
    ...traceFields,
  };
}

function retryEffect<T>(
  effect: Effect.Effect<T, RuntimeSafeError>,
  retry: RuntimeRetryOptions,
): Effect.Effect<T, RuntimeSafeError> {
  // attempt starts at 0; retries is the number of tries after the initial run.
  const runAttempt = (attempt: number): Effect.Effect<T, RuntimeSafeError> =>
    Effect.catchAll(effect, (error) => {
      const shouldRetry = retry.shouldRetry?.(error, attempt) ?? attempt < retry.retries;
      if (!shouldRetry || attempt >= retry.retries) {
        return Effect.fail(error);
      }

      const next = runAttempt(attempt + 1);
      return retry.delayMs === undefined || retry.delayMs <= 0
        ? next
        : Effect.flatMap(Effect.sleep(`${retry.delayMs} millis`), () => next);
    });

  return runAttempt(0);
}

function withTrace(
  error: RuntimeSafeError,
  trace: RuntimeTraceContext | undefined,
): RuntimeSafeError {
  if (trace?.traceId === undefined || error.traceId !== undefined) {
    return error;
  }
  return {
    ...error,
    traceId: trace.traceId,
  };
}

function traceFieldsFromContext(trace: RuntimeTraceContext | undefined): {
  traceId?: string;
  spanId?: string;
} {
  return {
    ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
    ...(trace?.spanId === undefined ? {} : { spanId: trace.spanId }),
  };
}
