import type {
  ObserverHealth,
  ObserverLifecycleFailure,
  ObserverStartupEvidence,
  ObserverStopReceipt,
  SafeError,
} from "@station/contracts";
import {
  ObserverLifecycleFailureSchema,
  STATION_SCHEMA_VERSION,
  textLineTerminatorPattern,
} from "@station/contracts";
import { componentLogPath, createJsonlLogger, createTraceContext } from "@station/observability";
import {
  createObserverClient,
  type ExpectedObserverIdentity,
  probeUnixSocket,
  unixSocketHolderEvidencePath,
} from "@station/protocol";
import {
  parseStationObserverBuildVersion,
  type RuntimeClock,
  type RuntimeTraceContext,
  runRuntimeBoundaryWithRetryAndTimeout,
  safeErrorFromUnknown,
  stationObserverBuildVersion,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { repairLocalObserverEvidence } from "./observerProcess/evidenceRepair.js";
import {
  classifyObserverHealth,
  formatObserverBuild,
  observerHandoffRefusedError,
} from "./observerProcess/health.js";
import { startObserverProcess } from "./observerProcess/startup.js";
import type {
  ExactObserverActivationPhase,
  ExactObserverBuildStatus,
  ExactObserverIncumbentDisposition,
  ObserverProcessDeps,
  ObserverProcessOptions,
  ObserverStatus,
} from "./observerProcess/types.js";
import { type ObserverPaths, resolveObserverPaths } from "./paths.js";

// Commands intentionally keep one stable lifecycle import while implementation lives in observerProcess/.
export type {
  ChildProcessLike,
  ExactObserverActivationPhase,
  ExactObserverBuildStatus,
  ExactObserverIncumbentDisposition,
  ObserverProcessDeps,
  ObserverProcessOptions,
  ObserverStatus,
} from "./observerProcess/types.js";

/**
 * ADAPTER
 *
 * Translates Observer socket and process evidence into a CLI-safe status without
 * spawning, unlinking, stopping, or signaling another process.
 */
export async function getObserverStatus(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const timeoutMs = observerStatusHealthTimeoutMs(options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  const probe = await (deps.probeSocket ?? probeUnixSocket)(paths.socketPath, { timeoutMs });
  if (probe.status === "stale") {
    return { status: "stale", paths };
  }
  if (probe.status === "inaccessible") {
    return { status: "unhealthy", paths, error: observerSocketInaccessibleError(paths.socketPath) };
  }

  const healthTimeoutMs = remainingStatusTimeoutMs(deadlineMs);
  if (healthTimeoutMs <= 0) {
    return probe.status === "absent" ? { status: "stopped", paths } : observerHealthTimedOut(paths);
  }

  const client =
    deps.clientFactory?.(paths.socketPath, {
      timeoutMs: healthTimeoutMs,
      acceptPreviousLifecycleSchema: true,
    }) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs: healthTimeoutMs,
      acceptPreviousLifecycleSchema: true,
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

function remainingStatusTimeoutMs(deadlineMs: number): number {
  return Math.max(0, Math.floor(deadlineMs - Date.now()));
}

function observerHealthTimedOut(paths: ObserverPaths): ObserverStatus {
  return {
    status: "unhealthy",
    paths,
    error: {
      tag: "ObserverConnectionError",
      code: "OBSERVER_HEALTH_TIMEOUT",
      message: `Observer status did not complete within its deadline for ${paths.socketPath}.`,
      hint: "Retry after checking socket ownership and Observer health.",
    },
  };
}

/**
 * ADAPTER
 *
 * Translates CLI startup intent into exact-build Observer attachment or child
 * startup while leaving claim-serialized stale-evidence repair and socket
 * ownership mutation to the child's boot lifecycle. Startup failures retain
 * their typed child cause and bounded boot evidence.
 */
export async function startObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  return startObserverWithPolicy(options, deps);
}

/**
 * ADAPTER
 *
 * Starts a child only when singleton boot claims preserve any listening incumbent.
 */
export const startObserverPreservingIncumbent = (
  options: ObserverProcessOptions,
  deps: ObserverProcessDeps,
): Promise<ObserverStatus> => startObserverWithPolicy(options, deps, "preserve");

async function startObserverWithPolicy(
  options: ObserverProcessOptions,
  deps: ObserverProcessDeps,
  incumbentPolicy?: "preserve",
): Promise<ObserverStatus> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clock = deps.clock ?? systemClock;
  const buildVersion = deps.buildVersion ?? stationObserverBuildVersion();
  const trace = createTraceContext({ operation: "cli.observer.start" });
  let replaceableIncumbent: ObserverHealth | undefined;
  const statusTimeoutMs = remainingObserverStartBudget(timeoutMs, options.startupDeadlineMs);
  if (statusTimeoutMs <= 0) return observerStartTimedOut(paths);
  const existing = await getObserverStatus({ ...options, paths, timeoutMs: statusTimeoutMs }, deps);
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
    if (classification.action === "replace") {
      replaceableIncumbent = existing.health;
    }
  }
  if (
    existing.status !== "running" &&
    (existing.status === "unhealthy" || existing.error?.code === "PROTOCOL_SCHEMA_MISMATCH")
  ) {
    return { ...existing, status: "unhealthy" };
  }

  const processTimeoutMs = remainingObserverStartBudget(timeoutMs, options.startupDeadlineMs);
  if (processTimeoutMs <= 0) return observerStartTimedOut(paths);

  const result = await startObserverProcess(
    {
      paths,
      timeoutMs: processTimeoutMs,
      ...(options.startupDeadlineMs === undefined
        ? {}
        : { startupDeadlineMs: options.startupDeadlineMs }),
      trace,
      clock,
      buildVersion,
      ...(replaceableIncumbent === undefined ? {} : { replaceableIncumbent }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.observerCommand === undefined
        ? {}
        : { observerCommand: options.observerCommand }),
      ...(options.onStartupProgress === undefined
        ? {}
        : { onStartupProgress: options.onStartupProgress }),
      ...(incumbentPolicy === undefined ? {} : { incumbentPolicy }),
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
    ...(result.cause === undefined ? {} : { cause: result.cause }),
    ...(result.startupEvidence === undefined ? {} : { startupEvidence: result.startupEvidence }),
    deps,
    clock,
  });
  return {
    status: "unhealthy",
    paths,
    error: result.error,
    ...(result.cause === undefined ? {} : { cause: result.cause }),
    ...(result.startupEvidence === undefined ? {} : { startupEvidence: result.startupEvidence }),
  };
}

function remainingObserverStartBudget(timeoutMs: number, deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return timeoutMs;
  return Math.min(timeoutMs, Math.floor(deadlineMs - Date.now()));
}

function observerStartTimedOut(paths: ObserverPaths): ObserverStatus {
  return {
    status: "unhealthy",
    paths,
    error: {
      tag: "ObserverStartupError",
      code: "OBSERVER_START_FAILED",
      message: "Observer did not become healthy before the startup timeout.",
    },
  };
}

/**
 * COMPOSITION ROOT
 *
 * Translates a CLI stop request into a pinned live lifecycle operation or a
 * claim-serialized, idempotent stale-evidence repair.
 */
export async function stopObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStopReceipt> {
  const paths = options.paths ?? resolveObserverPaths(options.config);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadlineMs = Date.now() + timeoutMs;
  const status = await getObserverStatus({ ...options, paths, timeoutMs }, deps);
  if (status.status === "running") {
    return stopRunningObserver(
      status,
      { ...options, paths, timeoutMs: remainingStopTimeoutMs(deadlineMs) },
      deps,
    );
  }
  if (status.status === "unhealthy") {
    throw (
      status.error ?? {
        tag: "ObserverConnectionError",
        code: "OBSERVER_NOT_RUNNING",
        message: "Observer is not running.",
      }
    );
  }

  try {
    const repairTimeoutMs = remainingStopTimeoutMs(deadlineMs);
    if (repairTimeoutMs <= 0) throw observerStopTimeoutError();
    const evidenceRepair = await (deps.repairStaleEvidence ?? repairLocalObserverEvidence)({
      socketPath: paths.socketPath,
      timeoutMs: repairTimeoutMs,
    });
    const clock = deps.clock ?? systemClock;
    return {
      schemaVersion: STATION_SCHEMA_VERSION,
      stopped: false,
      at: toIsoTimestamp(clock.now()),
      message: "Observer was already stopped; stale lifecycle evidence was reconciled.",
      evidenceRepair,
    };
  } catch (error) {
    const normalized = safeErrorFromUnknown(error, {
      tag: "ObserverEvidenceRepairError",
      code: "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
      message: "Observer lifecycle evidence could not be repaired safely.",
    });
    if (normalized.code !== "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED") throw error;
    const reclassificationTimeoutMs = remainingStopTimeoutMs(deadlineMs);
    if (reclassificationTimeoutMs <= 0) throw observerStopTimeoutError();
    const current = await getObserverStatus(
      { ...options, paths, timeoutMs: reclassificationTimeoutMs },
      deps,
    );
    if (current.status === "running") {
      return stopRunningObserver(
        current,
        { ...options, paths, timeoutMs: remainingStopTimeoutMs(deadlineMs) },
        deps,
      );
    }
    throw error;
  }
}

export function exactBuildActivationFailure(
  paths: ObserverPaths,
  input: {
    phase: ExactObserverActivationPhase;
    incumbentDisposition: ExactObserverIncumbentDisposition;
    error: unknown;
    cause?: SafeError;
    startupEvidence?: ObserverStartupEvidence;
  },
): ExactObserverBuildStatus {
  const cause =
    input.cause ??
    safeErrorFromUnknown(input.error, {
      tag: "ObserverStartupError",
      code: "OBSERVER_EXACT_BUILD_ACTIVATION_CAUSE_UNKNOWN",
      message: "The exact Observer build activation failed for an unknown reason.",
    });
  const error: SafeError = {
    tag: "ObserverStartupError",
    code: "OBSERVER_EXACT_BUILD_ACTIVATION_FAILED",
    message: "The exact Observer build could not be activated safely.",
    hint: exactBuildFailureHint(input.phase, input.incumbentDisposition),
  };
  if (cause.traceId !== undefined) error.traceId = cause.traceId;
  if (cause.diagnosticId !== undefined) error.diagnosticId = cause.diagnosticId;
  return {
    status: "unhealthy",
    paths,
    error,
    cause,
    ...(input.startupEvidence === undefined ? {} : { startupEvidence: input.startupEvidence }),
    phase: input.phase,
    incumbentDisposition: input.incumbentDisposition,
  };
}

export const exactObserverConvergenceError = (kind: string): SafeError => ({
  tag: "ObserverStartupError",
  code: `OBSERVER_EXACT_${kind}`,
  message: "Exact Observer convergence could not be proven safely.",
});

function exactBuildFailureHint(
  phase: ExactObserverActivationPhase,
  incumbentDisposition: ExactObserverIncumbentDisposition,
): string {
  const recovery =
    incumbentDisposition === "stopped"
      ? "The admitted incumbent stopped, but no exact successor was confirmed; retry the same activation command."
      : incumbentDisposition === "preserved"
        ? "No stop was attempted; resolve the reported access or ownership failure before retrying."
        : incumbentDisposition === "none"
          ? "No incumbent was observed, and no exact successor was confirmed; retry after resolving the startup failure."
          : "The admitted incumbent's final state could not be proven; inspect status before retrying.";
  return `Activation phase: ${phase}. Incumbent: ${incumbentDisposition}. ${recovery}`;
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
      acceptPreviousLifecycleSchema: true,
    }) ??
    createObserverClient({
      socketPath: status.paths.socketPath,
      timeoutMs: requestTimeoutMs,
      expectedObserverIdentity,
      acceptPreviousLifecycleSchema: true,
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
 * ADAPTER
 *
 * Translates a CLI restart request while preserving a newer winning Observer
 * build. An explicit higher-build restart cooperatively stops the
 * identity-pinned incumbent before spawn; a stopped or stale endpoint converges
 * through the child's claim-serialized evidence repair. A failed replacement
 * retains its typed cause and startup evidence while annotating only the outer
 * error hint with the incumbent build identity it tried to replace.
 */
export async function restartObserver(
  options: ObserverProcessOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<ObserverStatus> {
  const status = await getObserverStatus(options, deps);
  const incumbentHealth = status.status === "running" ? status.health : undefined;
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
    } else if (classification.action === "replace" || classification.reason === "exact-build") {
      await stopRunningObserver(status, options, deps);
    }
  }
  if (status.status === "unhealthy") return status;
  const started = await startObserver({ ...options, paths: status.paths }, deps);
  if (
    started.status === "unhealthy" &&
    started.error !== undefined &&
    incumbentHealth !== undefined
  ) {
    return {
      ...started,
      error: annotateReplacedIncumbent(started.error, incumbentHealth),
    };
  }
  return started;
}

function annotateReplacedIncumbent(error: SafeError, incumbent: ObserverHealth): SafeError {
  const context = `Restart was replacing incumbent ${formatObserverBuild(incumbent.version)} (pid ${incumbent.pid ?? "unknown"}).`;
  const hint = error.hint === undefined ? context : `${error.hint}\n${context}`;
  return { ...error, hint };
}

/** Renders a concise lifecycle failure with a separate cause and one executable next step. */
export function observerStatusErrorMessage(
  status: Exclude<ObserverStatus, { status: "running" }>,
): string {
  const error = status.error;
  if (error === undefined) {
    return "Observer is not running.";
  }

  const lines = [`${error.message} (${error.code})`];
  if (status.cause !== undefined) {
    lines.push(`Cause: ${status.cause.message} (${status.cause.code})`);
  }
  if (status.cause === undefined && error.hint !== undefined) {
    lines.push(`Next: ${error.hint.split(textLineTerminatorPattern).join(" ")}`);
    return lines.join("\n");
  }
  const traceId = error.traceId ?? status.cause?.traceId;
  lines.push(
    traceId === undefined ? "Next: stn observer status" : `Next: stn debug trace ${traceId}`,
  );
  return lines.join("\n");
}

/**
 * Preserves the strict lifecycle envelope when an auto-starting command cannot obtain a running Observer.
 */
export function assertObserverRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status === "running") return;
  throw observerLifecycleFailure(status);
}

/** Builds the strict public lifecycle envelope from one non-running Observer status. */
export function observerLifecycleFailure(
  status: Exclude<ObserverStatus, { status: "running" }>,
): ObserverLifecycleFailure {
  const failure: ObserverLifecycleFailure = {
    error:
      status.error ??
      ({
        tag: "ObserverStartupError",
        code: "OBSERVER_NOT_RUNNING",
        message: "Observer is not running.",
      } satisfies SafeError),
  };
  if (status.cause !== undefined) failure.cause = status.cause;
  if (status.startupEvidence !== undefined) failure.startupEvidence = status.startupEvidence;
  return ObserverLifecycleFailureSchema.parse(failure);
}

/**
 * ADAPTER
 *
 * Persists one redacted CLI lifecycle boundary with distinct outer error,
 * causal failure, and bounded startup evidence fields.
 */
export async function logObserverLifecycleFailure(input: {
  paths: ObserverPaths;
  operation: string;
  trace: RuntimeTraceContext;
  error: SafeError;
  cause?: SafeError;
  startupEvidence?: ObserverStartupEvidence;
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
        ...(input.cause === undefined ? {} : { cause: input.cause }),
        ...(input.startupEvidence === undefined ? {} : { startupEvidence: input.startupEvidence }),
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
  const evidencePath = unixSocketHolderEvidencePath();
  return {
    tag: "ObserverSocketError",
    code: "OBSERVER_SOCKET_INACCESSIBLE",
    message: "The Observer socket exists but cannot be reached or proven safe to reclaim.",
    hint: `Restore access to ${socketPath}, normally mode 0600. Station will not reclaim it without holder evidence from ${evidencePath}; install lsof if that executable is missing (Debian/Ubuntu: sudo apt-get install lsof; Fedora/RHEL: sudo dnf install lsof). Retry, or use an isolated socket and state directory. Do not unlink it or trust its pidfile as liveness proof.`,
  };
}

function observerStatusHealthTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? 2000, 5000);
}
