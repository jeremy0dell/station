import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ObserverHealth, SafeError } from "@station/contracts";
import { redactString } from "@station/observability";
import {
  Effect,
  type RuntimeBoundaryResult,
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithTimeout,
  withTimeout,
} from "@station/runtime";
import { observerHealthWaitCancelledError, waitForObserverHealth } from "./health.js";
import { defaultSpawnObserver, observerBootLogPath, readObserverBootLogTail } from "./spawn.js";
import type {
  ChildExitResult,
  ChildProcessLike,
  ObserverProcessDeps,
  ObserverProcessOptions,
  SpawnObserverInput,
} from "./types.js";

const incumbentHealthGraceMs = 1_000;

export async function startObserverProcess(
  input: {
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    trace: RuntimeTraceContext;
    clock: RuntimeClock;
    configPath?: string;
    onStartupProgress?: ObserverProcessOptions["onStartupProgress"];
  },
  deps: ObserverProcessDeps,
): Promise<RuntimeBoundaryResult<ObserverHealth>> {
  const progressTimers = scheduleObserverStartupProgress(input.onStartupProgress, input.paths);
  let child: ChildProcessLike | undefined;
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
      await mkdir(input.paths.stateDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(input.paths.socketPath), { recursive: true, mode: 0o700 });
      const spawnInput: SpawnObserverInput = { paths: input.paths };
      if (input.configPath !== undefined) {
        spawnInput.configPath = input.configPath;
      }
      child =
        deps.spawnObserver === undefined
          ? await defaultSpawnObserver({ ...spawnInput, startupTimeoutMs: input.timeoutMs })
          : await deps.spawnObserver(spawnInput);
      if (signal.aborted) {
        child.kill?.();
        throw observerHealthWaitCancelledError();
      }
      child.unref?.();
      return waitForStartedObserver(
        {
          child,
          paths: input.paths,
          timeoutMs: input.timeoutMs,
          trace: input.trace,
          signal,
        },
        deps,
      );
    },
  ).finally(() => clearObserverStartupProgress(progressTimers));

  if (!result.ok && result.error.code !== "OBSERVER_EXITED_ON_START") {
    child?.kill?.();
  }
  await disposeObserverBootLog(child);
  return result;
}

async function waitForStartedObserver(
  input: {
    child: ChildProcessLike;
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    trace: RuntimeTraceContext;
    signal: AbortSignal;
  },
  deps: ObserverProcessDeps,
): Promise<ObserverHealth> {
  const healthController = new AbortController();
  const cancelHealth = () => healthController.abort();
  input.signal.addEventListener("abort", cancelHealth, { once: true });
  const healthPromise = waitForObserverHealth(
    {
      paths: input.paths,
      timeoutMs: input.timeoutMs,
      trace: input.trace,
      signal: healthController.signal,
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

    try {
      // A losing child can exit just before the winning observer becomes healthy, so preserve its retry loop briefly.
      return await waitForIncumbentHealth(healthPromise, healthController);
    } catch {
      if (input.signal.aborted) {
        throw observerHealthWaitCancelledError();
      }
    }
    throw await observerExitedOnStartError(input.paths, input.child, outcome.exit, input.trace);
  } finally {
    input.signal.removeEventListener("abort", cancelHealth);
    healthController.abort();
    input.child.disposeExitWait?.();
    void healthPromise.catch(() => undefined);
  }
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
  child: ChildProcessLike,
): Promise<string> {
  const path = observerBootLogPath(paths);
  if (child.readBootLogTail !== undefined) {
    const pathHint = `Latest observer boot log: ${path}`;
    try {
      const tail = await child.readBootLogTail();
      if (tail === undefined) return pathHint;
      return `${pathHint}\nThis attempt's last 15 lines (redacted):\n${redactString(tail)}`;
    } catch {
      return pathHint;
    }
  }
  const pathHint = `Observer boot log: ${path}`;
  try {
    const tail = await readObserverBootLogTail(path);
    if (tail === undefined) {
      return pathHint;
    }
    return `${pathHint}\nLast 15 lines (redacted):\n${redactString(tail)}`;
  } catch {
    return pathHint;
  }
}

function waitForIncumbentHealth(
  healthPromise: Promise<ObserverHealth>,
  healthController: AbortController,
): Promise<ObserverHealth> {
  return withTimeout(
    async ({ signal }) => {
      const cancelHealth = () => healthController.abort();
      signal.addEventListener("abort", cancelHealth, { once: true });
      try {
        return await healthPromise;
      } finally {
        signal.removeEventListener("abort", cancelHealth);
      }
    },
    {
      timeoutMs: incumbentHealthGraceMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_INCUMBENT_HEALTH_FAILED",
        message: "Competing observer health check failed.",
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_INCUMBENT_HEALTH_TIMEOUT",
        message: "Competing observer did not become healthy during startup convergence.",
      },
    },
  );
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
): Array<ReturnType<typeof setTimeout>> {
  if (onProgress === undefined) {
    return [];
  }
  return [
    setTimeout(() => emitObserverStartupProgress(onProgress, "Starting STATION observer…"), 1_500),
    setTimeout(
      () =>
        emitObserverStartupProgress(
          onProgress,
          `Still waiting for STATION observer; boot log: ${observerBootLogPath(paths)}`,
        ),
      5_000,
    ),
  ];
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
