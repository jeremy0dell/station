import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ObserverHealth, SafeError } from "@station/contracts";
import { redactString } from "@station/observability";
import {
  Effect,
  isSafeError,
  publicSafeErrorFromUnknown,
  type RuntimeBoundaryResult,
  type RuntimeClock,
  type RuntimeSafeError,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import {
  observerHandoffRefusedError,
  observerHealthWaitCancelledError,
  waitForObserverHealth,
} from "./health.js";
import { defaultSpawnObserver, observerBootLogPath, readObserverBootLogTail } from "./spawn.js";
import type {
  ChildExitResult,
  ChildProcessLike,
  ObserverProcessDeps,
  ObserverProcessOptions,
  SpawnObserverInput,
} from "./types.js";

const incumbentHealthGraceMs = 1_000;

/**
 * Starts the Observer child and waits for exact-build health inside one timed runtime boundary.
 * Startup failures are enriched with the redacted boot reason and the child-owned boot-log tail
 * before the boot-log handle is disposed.
 */
export async function startObserverProcess(
  input: {
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    buildVersion: string;
    trace: RuntimeTraceContext;
    clock: RuntimeClock;
    configPath?: string;
    onStartupProgress?: ObserverProcessOptions["onStartupProgress"];
  },
  deps: ObserverProcessDeps,
): Promise<RuntimeBoundaryResult<ObserverHealth>> {
  const startupProgress = scheduleObserverStartupProgress(input.onStartupProgress, input.paths);
  let child: ChildProcessLike | undefined;
  let startupFailureReason: string | undefined;
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.observer.start",
      clock: input.clock,
      timeoutMs: input.timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer startup failed.",
        hint: `Run station debug trace ${input.trace.traceId}.`,
        traceId: input.trace.traceId,
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer did not become healthy before the startup timeout.",
        hint: `Run station debug trace ${input.trace.traceId}.`,
        traceId: input.trace.traceId,
      },
      trace: input.trace,
    },
    async ({ signal }) => {
      try {
        await mkdir(input.paths.stateDir, { recursive: true, mode: 0o700 });
        await mkdir(dirname(input.paths.socketPath), { recursive: true, mode: 0o700 });
        const spawnInput: SpawnObserverInput = { paths: input.paths };
        if (input.configPath !== undefined) {
          spawnInput.configPath = input.configPath;
        }
        child =
          deps.spawnObserver === undefined
            ? await defaultSpawnObserver({
                ...spawnInput,
                startupTimeoutMs: input.timeoutMs,
                buildVersion: input.buildVersion,
              })
            : await deps.spawnObserver(spawnInput);
        if (signal.aborted) {
          child.kill?.();
          throw observerHealthWaitCancelledError();
        }
        child.unref?.();
        return await waitForStartedObserver(
          {
            child,
            paths: input.paths,
            timeoutMs: input.timeoutMs,
            buildVersion: input.buildVersion,
            trace: input.trace,
            signal,
          },
          deps,
        );
      } catch (error) {
        startupFailureReason = redactedStartupFailureReason(error);
        throw error;
      }
    },
  ).finally(() => startupProgress.dispose());

  // A child queued on the boot claim must not outlive the incumbent this caller attached to.
  if (result.ok && child?.pid !== undefined && child.pid !== result.value.pid) {
    child.kill?.();
  }
  if (!result.ok && result.error.code !== "OBSERVER_EXITED_ON_START") {
    child?.kill?.();
  }
  if (result.ok) {
    await disposeObserverBootLog(child);
    return result;
  }
  const error = await enrichStartupFailureEvidence({
    error: result.error,
    reason: startupFailureReason,
    paths: input.paths,
    child,
  });
  await disposeObserverBootLog(child);
  return { ...result, error };
}

async function waitForStartedObserver(
  input: {
    child: ChildProcessLike;
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    buildVersion: string;
    trace: RuntimeTraceContext;
    signal: AbortSignal;
  },
  deps: ObserverProcessDeps,
): Promise<ObserverHealth> {
  const healthController = new AbortController();
  let replaceableIncumbent: ObserverHealth | undefined;
  const cancelHealth = () => healthController.abort();
  input.signal.addEventListener("abort", cancelHealth, { once: true });
  const healthPromise = waitForObserverHealth(
    {
      paths: input.paths,
      timeoutMs: input.timeoutMs,
      buildVersion: input.buildVersion,
      trace: input.trace,
      signal: healthController.signal,
      onBuildClassification: (classification, health) => {
        if (classification.action === "replace") {
          replaceableIncumbent = health;
        }
      },
    },
    deps,
  );

  try {
    const childExit = input.child.exited;
    if (childExit === undefined) {
      return await healthPromise;
    }

    // Early child termination must preempt the health timeout.
    const outcome = await Effect.runPromise(
      Effect.raceFirst(
        Effect.tryPromise({
          try: () => healthPromise,
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ type: "error" as const, error }),
            onSuccess: (health) => ({ type: "healthy" as const, health }),
          }),
        ),
        Effect.tryPromise({
          try: () => childExit,
          catch: (error) => error,
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ type: "error" as const, error }),
            onSuccess: (exit) => ({ type: "exited" as const, exit }),
          }),
        ),
      ),
    );
    if (outcome.type === "error") {
      throw outcome.error;
    }
    if (outcome.type === "healthy") {
      return outcome.health;
    }

    let convergenceError: unknown;
    try {
      // A losing child can exit just before the winning observer becomes healthy, so preserve its retry loop briefly.
      return await waitForIncumbentHealth(healthPromise, healthController);
    } catch (error) {
      if (input.signal.aborted) {
        throw observerHealthWaitCancelledError();
      }
      convergenceError = error;
    }
    if (replaceableIncumbent !== undefined) {
      throw await observerReplacementExitedError(
        replaceableIncumbent,
        input.buildVersion,
        input.paths,
        input.child,
        outcome.exit,
        convergenceError,
        input.trace,
      );
    }
    throw await observerExitedOnStartError(input.paths, input.child, outcome.exit, input.trace);
  } finally {
    input.signal.removeEventListener("abort", cancelHealth);
    healthController.abort();
    input.child.disposeExitWait?.();
    void healthPromise.catch(() => undefined);
  }
}

async function observerReplacementExitedError(
  incumbent: ObserverHealth,
  requestedVersion: string,
  paths: SpawnObserverInput["paths"],
  child: ChildProcessLike,
  exit: ChildExitResult,
  convergenceFailure: unknown,
  trace: RuntimeTraceContext,
): Promise<SafeError> {
  const convergence = publicSafeErrorFromUnknown(convergenceFailure, {
    tag: "ObserverStartupError",
    code: "OBSERVER_HEALTH_FAILED",
    message: "Observer health check failed during startup convergence.",
  });
  const convergenceDescription =
    convergence.code === "OBSERVER_INCUMBENT_HEALTH_TIMEOUT"
      ? `${convergence.code} after ${incumbentHealthGraceMs} ms`
      : convergence.code;
  const bootLogHint = await observerBootLogHint(paths, child);
  const traceHint =
    trace.traceId === undefined ? "" : `\nRun station debug trace ${trace.traceId}.`;
  const error = observerHandoffRefusedError(
    incumbent,
    requestedVersion,
    `Replacement child: ${childExitDescription(exit)}. Health convergence: ${convergenceDescription}.\n${bootLogHint}${traceHint}`,
  );
  if (trace.traceId !== undefined) {
    error.traceId = trace.traceId;
  }
  return error;
}

async function observerExitedOnStartError(
  paths: SpawnObserverInput["paths"],
  child: ChildProcessLike,
  exit: ChildExitResult,
  trace: RuntimeTraceContext,
): Promise<SafeError> {
  const bootLogHint = await observerBootLogHint(paths, child);
  const traceHint =
    trace.traceId === undefined ? "" : `\nRun station debug trace ${trace.traceId}.`;
  const error: SafeError = {
    tag: "ObserverStartupError",
    code: "OBSERVER_EXITED_ON_START",
    message: `Observer exited before becoming healthy (${childExitDescription(exit)}).`,
    hint: `${bootLogHint}${traceHint}`,
  };
  if (trace.traceId !== undefined) {
    error.traceId = trace.traceId;
  }
  return error;
}

function childExitDescription(exit: ChildExitResult): string {
  if (exit.type === "spawn_error") {
    return `spawn error: ${redactString(exit.error.message)}`;
  }
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }
  if (exit.code !== null) {
    return `exit code ${exit.code}`;
  }
  return "unknown exit status";
}

async function observerBootLogHint(
  paths: SpawnObserverInput["paths"],
  child: ChildProcessLike | undefined,
): Promise<string> {
  const path = observerBootLogPath(paths);
  if (child?.readBootLogTail !== undefined) {
    const pathHint = `Latest observer boot log: ${path}`;
    try {
      const tail = await child.readBootLogTail();
      if (tail === undefined) {
        return `${pathHint}\nBoot-log tail unavailable (missing, empty, or unreadable).`;
      }
      return `${pathHint}\nThis attempt's last 15 lines (redacted):\n${redactString(tail)}`;
    } catch {
      return `${pathHint}\nBoot-log tail unavailable (missing, empty, or unreadable).`;
    }
  }
  const pathHint = `Observer boot log: ${path}`;
  try {
    const tail = await readObserverBootLogTail(path);
    if (tail === undefined) {
      return `${pathHint}\nBoot-log tail unavailable (missing, empty, or unreadable).`;
    }
    return `${pathHint}\nLast 15 lines (redacted):\n${redactString(tail)}`;
  } catch {
    return `${pathHint}\nBoot-log tail unavailable (missing, empty, or unreadable).`;
  }
}

function waitForIncumbentHealth(
  healthPromise: Promise<ObserverHealth>,
  healthController: AbortController,
): Promise<ObserverHealth> {
  // Reject before aborting so grace expiry remains distinct from the health poll's cancellation error.
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject({
        tag: "ObserverStartupError",
        code: "OBSERVER_INCUMBENT_HEALTH_TIMEOUT",
        message: "Competing observer did not become healthy during startup convergence.",
      } satisfies SafeError);
      healthController.abort();
    }, incumbentHealthGraceMs);
    void healthPromise.then(
      (health) => {
        clearTimeout(timeout);
        resolve(health);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Appends the redacted spawn reason and the child-owned boot-log tail to a flattened or timed-out
 * startup error. Runs after the runtime boundary so one path covers both the timeout failure and
 * non-SafeError flattening, neither of which reaches the early-exit error builders that already
 * carry this evidence.
 */
async function enrichStartupFailureEvidence(input: {
  error: RuntimeSafeError;
  reason: string | undefined;
  paths: SpawnObserverInput["paths"];
  child: ChildProcessLike | undefined;
}): Promise<RuntimeSafeError> {
  if (input.error.hint?.includes(observerBootLogPath(input.paths)) === true) {
    return input.error;
  }
  const evidence = [
    ...(input.reason === undefined ? [] : [`Startup failure: ${input.reason}`]),
    await observerBootLogHint(input.paths, input.child),
  ].join("\n");
  const hint = input.error.hint === undefined ? evidence : `${input.error.hint}\n${evidence}`;
  return { ...input.error, hint };
}

/**
 * Reduces a non-SafeError startup escape to its first redacted line; typed SafeErrors already
 * carry their own sanitized shape and pass through the boundary untouched.
 */
function redactedStartupFailureReason(error: unknown): string | undefined {
  if (isSafeError(error)) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const [firstLine] = redactString(message).split("\n");
  return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine;
}

async function disposeObserverBootLog(child: ChildProcessLike | undefined): Promise<void> {
  try {
    await child?.disposeBootLog?.();
  } catch {
    // Diagnostic handle cleanup must not replace the observer startup result.
  }
}

function scheduleObserverStartupProgress(
  onProgress: ObserverProcessOptions["onStartupProgress"],
  paths: SpawnObserverInput["paths"],
): { dispose: () => void } {
  if (onProgress === undefined) {
    return { dispose: () => undefined };
  }
  // clearTimeout alone cannot retract a callback the event loop already
  // dequeued, and a late emission would land in whatever the caller moved on
  // to (an active Clack prompt swallows its pending answer when log output
  // interleaves), so emission is gated on startup still being in flight.
  let settled = false;
  const emit = (message: string): void => {
    if (!settled) emitObserverStartupProgress(onProgress, message);
  };
  const timers = [
    setTimeout(() => emit("Starting STATION observer…"), 1_500),
    setTimeout(
      () => emit(`Still waiting for STATION observer; boot log: ${observerBootLogPath(paths)}`),
      5_000,
    ),
  ];
  return {
    dispose: () => {
      settled = true;
      clearObserverStartupProgress(timers);
    },
  };
}

function emitObserverStartupProgress(
  onProgress: NonNullable<ObserverProcessOptions["onStartupProgress"]>,
  message: string,
): void {
  try {
    onProgress(message);
  } catch {
    // Progress output must not turn a successful observer launch into a startup failure.
  }
}

function clearObserverStartupProgress(timers: readonly ReturnType<typeof setTimeout>[]): void {
  for (const timer of timers) {
    clearTimeout(timer);
  }
}
