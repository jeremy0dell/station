import { type ChildProcess, spawn } from "node:child_process";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StationConfig } from "@station/config";
import type { ObserverHealth, ObserverStopReceipt, SafeError } from "@station/contracts";
import {
  componentLogPath,
  createJsonlLogger,
  createTraceContext,
  type JsonlLogger,
  redactString,
} from "@station/observability";
import { createObserverClient, isSocketStale, removeStaleSocket } from "@station/protocol";
import {
  Effect,
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  runRuntimeBoundaryWithTimeout,
  safeErrorFromUnknown,
  systemClock,
} from "@station/runtime";
import { type ObserverPaths, resolveObserverPaths } from "./paths.js";

export type ObserverStatus =
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

export type ObserverProcessDeps = {
  clientFactory?: (socketPath: string) => ReturnType<typeof createObserverClient>;
  spawnObserver?: (input: SpawnObserverInput) => ChildProcessLike | Promise<ChildProcessLike>;
  clock?: RuntimeClock;
  sleep?: (ms: number) => Promise<void>;
  logger?: JsonlLogger;
};

export type SpawnObserverInput = {
  paths: ObserverPaths;
  configPath?: string;
};

type ChildExitResult =
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: "spawn_error";
      error: Error;
    };

export type ChildProcessLike = Pick<ChildProcess, "pid" | "unref"> & {
  kill?: ChildProcess["kill"];
  exited?: Promise<ChildExitResult>;
  disposeExitWait?: () => void;
};

export type ObserverProcessOptions = {
  config?: StationConfig;
  configPath?: string;
  paths?: ObserverPaths;
  timeoutMs?: number;
  onStartupProgress?: (message: string) => void;
};

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

export async function startObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clock = deps.clock ?? systemClock;
  const trace = createTraceContext({ operation: "cli.observer.start" });
  const existing = await getObserverStatus({ ...options, paths }, deps);
  if (existing.status === "running") {
    return existing;
  }
  if (existing.status === "stale") {
    await removeStaleSocket(paths.socketPath);
  }
  if (existing.status === "unhealthy") {
    return existing;
  }

  const progressTimers = scheduleObserverStartupProgress(options.onStartupProgress, paths);
  // Spawning only starts the daemon; report running only after the socket health check succeeds.
  let child: ChildProcessLike | undefined;
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.observer.start",
      clock,
      timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer startup failed.",
        hint: `Run station debug trace ${trace.traceId}.`,
        traceId: trace.traceId,
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_START_FAILED",
        message: "Observer did not become healthy before the startup timeout.",
        hint: `Run station debug trace ${trace.traceId}.`,
        traceId: trace.traceId,
      },
      trace,
    },
    async ({ signal }) => {
      await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
      child = await (deps.spawnObserver ?? defaultSpawnObserver)({
        paths,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      });
      if (signal.aborted) {
        child.kill?.();
        throw observerHealthWaitCancelledError();
      }
      child.unref?.();
      return waitForStartedObserver({ child, paths, timeoutMs, trace, signal }, deps);
    },
  ).finally(() => clearObserverStartupProgress(progressTimers));

  if (result.ok) {
    return {
      status: "running",
      paths,
      health: result.value,
    };
  }

  if (result.error.code !== "OBSERVER_EXITED_ON_START") {
    child?.kill?.();
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

export async function waitForObserverHealth(
  options: {
    paths: ObserverPaths;
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
    {
      operation: "cli.observer.waitForHealth",
      timeoutMs,
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_HEALTH_FAILED",
        message: "Observer health check failed.",
        ...(options.trace?.traceId === undefined
          ? {}
          : {
              hint: `Run station debug trace ${options.trace.traceId}.`,
              traceId: options.trace.traceId,
            }),
      },
      timeoutError: {
        tag: "ObserverStartupError",
        code: "OBSERVER_HEALTH_TIMEOUT",
        message: "Observer did not report healthy before the timeout.",
        ...(options.trace?.traceId === undefined
          ? {}
          : {
              hint: `Run station debug trace ${options.trace.traceId}.`,
              traceId: options.trace.traceId,
            }),
      },
      retry: {
        retries,
        delayMs: 25,
        shouldRetry: (error, attempt) =>
          error.code !== "OBSERVER_HEALTH_WAIT_CANCELLED" && attempt < retries,
      },
      trace: options.trace,
    },
    async ({ signal }) => {
      const signals = [signal, options.signal].filter(isAbortSignal);
      if (signals.some((candidate) => candidate.aborted)) {
        throw observerHealthWaitCancelledError();
      }
      return abortableObserverHealth(client.health(), signals);
    },
  );

  if (!result.ok) {
    throw result.error;
  }
  return result.value;
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

function defaultClientFactory(socketPath: string) {
  return createObserverClient({ socketPath, timeoutMs: 500 });
}

async function defaultSpawnObserver(input: SpawnObserverInput): Promise<ChildProcessLike> {
  const argv = observerSpawnArgv(input);
  const bootLogPath = observerBootLogPath(input.paths);
  await mkdir(dirname(bootLogPath), { recursive: true, mode: 0o700 });
  const bootLog = await open(bootLogPath, "w", 0o600);
  let child: ChildProcess | undefined;
  let startedChild: ChildProcessLike;
  try {
    await bootLog.chmod(0o600);
    await bootLog.writeFile(`${JSON.stringify({ command: argv })}\n`, "utf8");
    const [command, ...args] = argv;
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", bootLog.fd, bootLog.fd],
    });
    startedChild = childWithExit(child);
  } catch (error) {
    await bootLog.close().catch(() => undefined);
    throw error;
  }
  try {
    await bootLog.close();
  } catch (error) {
    child.kill();
    throw error;
  }
  return startedChild;
}

function observerSpawnArgv(input: SpawnObserverInput): [string, ...string[]] {
  const observerEntry = new URL("../dist/observerMain.js", import.meta.url);
  return [
    process.execPath,
    observerEntry.pathname,
    "--socket",
    input.paths.socketPath,
    "--state-dir",
    input.paths.stateDir,
    ...(input.configPath === undefined ? [] : ["--config", input.configPath]),
  ];
}

function childWithExit(child: ChildProcess): ChildProcessLike {
  let disposeExitWait!: () => void;
  const exited = new Promise<ChildExitResult>((resolve) => {
    let settled = false;
    const finish = (result: ChildExitResult) => {
      if (settled) return;
      settled = true;
      disposeExitWait();
      resolve(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ type: "exit", code, signal });
    };
    const onError = (error: Error) => {
      finish({ type: "spawn_error", error });
    };
    disposeExitWait = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return Object.assign(child, { exited, disposeExitWait });
}

async function waitForStartedObserver(
  input: {
    child: ChildProcessLike;
    paths: ObserverPaths;
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

    healthController.abort();
    try {
      // A competing observer may have won the socket immediately before this child exited.
      return await probeObserverHealth(input.paths, deps, input.signal);
    } catch {
      if (input.signal.aborted) {
        throw observerHealthWaitCancelledError();
      }
    }
    throw await observerExitedOnStartError(input.paths, outcome.exit, input.trace);
  } finally {
    input.signal.removeEventListener("abort", cancelHealth);
    healthController.abort();
    input.child.disposeExitWait?.();
    void healthPromise.catch(() => undefined);
  }
}

function probeObserverHealth(
  paths: ObserverPaths,
  deps: ObserverProcessDeps,
  signal: AbortSignal,
): Promise<ObserverHealth> {
  const client = (deps.clientFactory ?? defaultClientFactory)(paths.socketPath);
  return abortableObserverHealth(client.health(), [signal]);
}

async function observerExitedOnStartError(
  paths: ObserverPaths,
  exit: ChildExitResult,
  trace: RuntimeTraceContext,
): Promise<SafeError> {
  const bootLogHint = await observerBootLogHint(paths);
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

async function observerBootLogHint(paths: ObserverPaths): Promise<string> {
  const path = observerBootLogPath(paths);
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

async function readObserverBootLogTail(path: string): Promise<string | undefined> {
  const maxBytes = 64 * 1024;
  const bootLog = await open(path, "r");
  try {
    const { size } = await bootLog.stat();
    if (size === 0) return undefined;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await bootLog.read(buffer, 0, length, size - length);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > length) {
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    }
    content = content.trimEnd();
    if (content.trim().length === 0) return undefined;
    return content.split(/\r?\n/).slice(-15).join("\n");
  } finally {
    await bootLog.close();
  }
}

function observerBootLogPath(paths: ObserverPaths): string {
  return join(paths.stateDir, "logs", "observer-boot.log");
}

function scheduleObserverStartupProgress(
  onProgress: ObserverProcessOptions["onStartupProgress"],
  paths: ObserverPaths,
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

function observerHealthWaitCancelledError(): SafeError {
  return {
    tag: "CancellationError",
    code: "OBSERVER_HEALTH_WAIT_CANCELLED",
    message: "Observer health wait was cancelled.",
  };
}

function isAbortSignal(value: AbortSignal | undefined): value is AbortSignal {
  return value !== undefined;
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
