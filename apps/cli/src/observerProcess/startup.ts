import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_BYTES,
  OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_LINES,
  type ObserverHealth,
  type ObserverStartupEvidence,
  type SafeError,
  textLineTerminatorPattern,
} from "@station/contracts";
import { redactString } from "@station/observability";
import {
  Effect,
  publicSafeErrorFromUnknown,
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import { normalizeObserverStartupFailure } from "./failureReport.js";
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
  ObserverStartupProcessResult,
  SpawnObserverInput,
} from "./types.js";

const incumbentHealthGraceMs = 1_000;

type ObserverStartupFailureEvidence = {
  error: SafeError;
  cause?: SafeError;
  startupEvidence: ObserverStartupEvidence;
};

type StartedObserverResult =
  | { ok: true; health: ObserverHealth }
  | { ok: false; failure: ObserverStartupFailureEvidence };

/**
 * ADAPTER
 *
 * Starts the Observer child and waits for exact-build health inside one timed runtime boundary,
 * retaining a separate typed cause and bounded boot evidence before diagnostic handles close.
 */
export async function startObserverProcess(
  input: {
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    buildVersion: string;
    replaceableIncumbent?: ObserverHealth;
    trace: RuntimeTraceContext;
    clock: RuntimeClock;
    configPath?: string;
    observerCommand?: SpawnObserverInput["observerCommand"];
    incumbentPolicy?: SpawnObserverInput["incumbentPolicy"];
    onStartupProgress?: ObserverProcessOptions["onStartupProgress"];
  },
  deps: ObserverProcessDeps,
): Promise<ObserverStartupProcessResult> {
  const startupProgress = scheduleObserverStartupProgress(input.onStartupProgress, input.paths);
  let child: ChildProcessLike | undefined;
  let startupCause: SafeError | undefined;
  let startupEvidence: ObserverStartupEvidence | undefined;
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.observer.start",
      clock: input.clock,
      timeoutMs: input.timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer startup failed.",
        hint: `Run stn debug trace ${input.trace.traceId}.`,
        traceId: input.trace.traceId,
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer did not become healthy before the startup timeout.",
        hint: `Run stn debug trace ${input.trace.traceId}.`,
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
        if (input.observerCommand !== undefined) {
          spawnInput.observerCommand = input.observerCommand;
        }
        if (input.incumbentPolicy !== undefined) {
          spawnInput.incumbentPolicy = input.incumbentPolicy;
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
        const started = await waitForStartedObserver(
          {
            child,
            paths: input.paths,
            timeoutMs: input.timeoutMs,
            buildVersion: input.buildVersion,
            ...(input.replaceableIncumbent === undefined
              ? {}
              : { replaceableIncumbent: input.replaceableIncumbent }),
            trace: input.trace,
            signal,
          },
          deps,
        );
        if (!started.ok) {
          startupCause = started.failure.cause;
          startupEvidence = started.failure.startupEvidence;
          throw started.failure.error;
        }
        return started.health;
      } catch (error) {
        if (startupCause === undefined) {
          const report = normalizeObserverStartupFailure(error);
          startupCause = report.cause ?? report.error;
        }
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
    child?.disposeFailureReport?.();
    await disposeObserverBootLog(child);
    return result;
  }
  startupEvidence ??= await readObserverStartupEvidence(input.paths, child);
  child?.disposeFailureReport?.();
  await disposeObserverBootLog(child);
  return {
    ...result,
    ...(startupCause === undefined ? {} : { cause: startupCause }),
    ...(startupEvidence === undefined ? {} : { startupEvidence }),
  };
}

async function waitForStartedObserver(
  input: {
    child: ChildProcessLike;
    paths: SpawnObserverInput["paths"];
    timeoutMs: number;
    buildVersion: string;
    replaceableIncumbent?: ObserverHealth;
    trace: RuntimeTraceContext;
    signal: AbortSignal;
  },
  deps: ObserverProcessDeps,
): Promise<StartedObserverResult> {
  const healthController = new AbortController();
  let replaceableIncumbent = input.replaceableIncumbent;
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
      try {
        return { ok: true, health: await healthPromise };
      } catch (error) {
        if (replaceableIncumbent !== undefined) {
          throw observerHandoffRefusedError(
            replaceableIncumbent,
            input.buildVersion,
            "The replacement process did not publish compatible health.",
          );
        }
        throw error;
      }
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
      return { ok: true, health: outcome.health };
    }

    let convergenceError: unknown;
    try {
      // A losing child can exit just before the winning observer becomes healthy, so preserve its retry loop briefly.
      return { ok: true, health: await waitForIncumbentHealth(healthPromise, healthController) };
    } catch (error) {
      if (input.signal.aborted) {
        throw observerHealthWaitCancelledError();
      }
      convergenceError = error;
    }
    const reportedCause = startupCauseFromExit(outcome.exit);
    if (replaceableIncumbent !== undefined) {
      const cause =
        reportedCause ??
        publicSafeErrorFromUnknown(convergenceError, {
          tag: "ObserverStartupError",
          code: "OBSERVER_HEALTH_FAILED",
          message: "Observer health check failed during startup convergence.",
        });
      const handoffError = observerHandoffRefusedError(
        replaceableIncumbent,
        input.buildVersion,
        "The replacement process exited before publishing compatible health.",
      );
      handoffError.traceId = input.trace.traceId;
      return {
        ok: false,
        failure: await observerExitedFailure(input.paths, input.child, handoffError, cause),
      };
    }
    return {
      ok: false,
      failure: await observerExitedFailure(
        input.paths,
        input.child,
        {
          tag: "ObserverStartupError",
          code: "OBSERVER_EXITED_ON_START",
          message: `Observer exited before becoming healthy (${childExitDescription(outcome.exit)}).`,
          hint: `Run stn debug trace ${input.trace.traceId}.`,
          traceId: input.trace.traceId,
        },
        reportedCause,
      ),
    };
  } finally {
    input.signal.removeEventListener("abort", cancelHealth);
    healthController.abort();
    input.child.disposeExitWait?.();
    void healthPromise.catch(() => undefined);
  }
}

async function observerExitedFailure(
  paths: SpawnObserverInput["paths"],
  child: ChildProcessLike,
  error: SafeError,
  cause: SafeError | undefined,
): Promise<ObserverStartupFailureEvidence> {
  return {
    error,
    ...(cause === undefined ? {} : { cause }),
    startupEvidence: await readObserverStartupEvidence(paths, child),
  };
}

function childExitDescription(exit: ChildExitResult): string {
  if (exit.type === "spawn_error") {
    return "spawn error";
  }
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }
  if (exit.code !== null) {
    return `exit code ${exit.code}`;
  }
  return "unknown exit status";
}

function startupCauseFromExit(exit: ChildExitResult): SafeError | undefined {
  if (exit.report !== undefined) {
    return exit.report.cause ?? exit.report.error;
  }
  if (exit.type === "spawn_error") {
    const report = normalizeObserverStartupFailure(exit.error);
    return report.cause ?? report.error;
  }
  return undefined;
}

async function readObserverStartupEvidence(
  paths: SpawnObserverInput["paths"],
  child: ChildProcessLike | undefined,
): Promise<ObserverStartupEvidence> {
  const evidence: ObserverStartupEvidence = { bootLogPath: observerBootLogPath(paths) };
  try {
    const tail =
      child?.readBootLogTail === undefined
        ? await readObserverBootLogTail(evidence.bootLogPath)
        : await child.readBootLogTail();
    const boundedTail = boundedRedactedBootLogTail(tail);
    if (boundedTail !== undefined) evidence.bootLogTail = boundedTail;
  } catch {
    // The boot log path remains useful when the optional tail cannot be read.
  }
  return evidence;
}

function boundedRedactedBootLogTail(tail: string | undefined): string | undefined {
  if (tail === undefined) return undefined;
  const redacted = redactString(tail)
    .split(textLineTerminatorPattern)
    .slice(-OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_LINES)
    .join("\n")
    .trimEnd();
  if (redacted.length === 0) return undefined;
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.byteLength <= OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_BYTES) return redacted;
  let start = encoded.byteLength - OBSERVER_STARTUP_BOOT_LOG_TAIL_MAX_BYTES;
  while (start < encoded.byteLength && (encoded[start] ?? 0) >> 6 === 2) start += 1;
  return encoded.subarray(start).toString("utf8");
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
