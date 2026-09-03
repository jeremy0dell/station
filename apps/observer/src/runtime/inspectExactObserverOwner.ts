import type {
  ObserverHealth,
  ObserverProcessIdentity,
  ObserverRecoveryAssessment,
  SafeError,
} from "@station/contracts";
import { parseStationObserverBuildVersion } from "@station/runtime";
import { toSafeError } from "../diagnostics/errors.js";
import {
  type ObserverCooperativeProcessEntry,
  type ObserverCooperativeProcessEvidenceSource,
  verifyCooperativeObserverProcessIdentity,
} from "./observerCooperativeProcessIdentity.js";
import { observerProcessIdentitiesMatch } from "./observerProcessIdentity.js";

/** Fail-closed classification for exact Observer ownership inspection. */
export type ExactObserverInspectionFailureReason =
  | "stale-socket"
  | "unhealthy"
  | "identity-missing"
  | "identity-unavailable"
  | "identity-mismatch"
  | "identity-drift"
  | "process-without-socket";

/** Endpoint status evidence admitted by exact Observer inspection. */
export type ExactObserverStatusEvidence =
  | { readonly status: "running"; readonly health: ObserverHealth }
  | { readonly status: "stopped" | "stale" | "unhealthy"; readonly error?: SafeError };

/** Complete health identity pin for a recovery-assessment read. */
export interface PinnedObserverRecoveryIdentity {
  readonly pid: number;
  readonly startedAt: string;
  readonly version: string;
  readonly socketPath: string;
}

/** Required health identity returned only after exact ownership inspection. */
export type ExactObserverHealthEvidence = Readonly<ObserverHealth & PinnedObserverRecoveryIdentity>;

/** Complete cooperative process generation returned only after exact ownership inspection. */
export type ExactObserverProcessEvidence = Readonly<
  ObserverCooperativeProcessEntry &
    Required<Pick<ObserverCooperativeProcessEntry, "socketPath" | "startupTimeoutMs">>
>;

/**
 * DRIVEN PORT
 *
 * Supplies read-only status, pidfile, cooperative process, and pinned recovery evidence.
 */
export type ExactObserverInspectionPorts = Readonly<{
  readStatus: () => Promise<ExactObserverStatusEvidence>;
  readPidfileIdentity: (socketPath: string) => Promise<ObserverProcessIdentity | undefined>;
  processEvidence: ObserverCooperativeProcessEvidenceSource;
  readRecoveryAssessment: (
    identity: PinnedObserverRecoveryIdentity,
  ) => Promise<ObserverRecoveryAssessment>;
}>;

/** Coherent immutable evidence for one exact Observer ownership inspection. */
export type ExactObserverOwnershipEvidence =
  | { readonly status: "absent" }
  | {
      readonly status: "blocked";
      readonly reason: ExactObserverInspectionFailureReason;
      readonly error?: SafeError;
    }
  | {
      readonly status: "exact";
      readonly health: ExactObserverHealthEvidence;
      readonly processIdentity: Readonly<ObserverProcessIdentity>;
      readonly process: ExactObserverProcessEvidence;
      readonly recovery:
        | { readonly status: "assessed"; readonly assessment: ObserverRecoveryAssessment }
        | { readonly status: "unknown"; readonly error: SafeError };
    };

/**
 * USE CASE
 *
 * Captures and revalidates one coherent Observer generation around recovery inspection.
 */
export async function inspectExactObserverOwner(
  input: { readonly socketPath: string },
  ports: ExactObserverInspectionPorts,
): Promise<ExactObserverOwnershipEvidence> {
  const initialStatus = await capture(ports.readStatus);
  if (!initialStatus.ok) return blocked("unhealthy", initialStatus.error);
  const status = initialStatus.value;
  if (status.status !== "running") {
    if (status.status === "stopped") return inspectStopped(input.socketPath, ports);
    return blocked(status.status === "stale" ? "stale-socket" : "unhealthy", status.error);
  }

  const health = status.health;
  if (!hasExactHealthEvidence(health, input.socketPath)) {
    return blocked("identity-missing");
  }
  const recoveryIdentity = {
    pid: health.pid,
    startedAt: health.startedAt,
    version: health.version,
    socketPath: health.socketPath,
  };

  const identityRead = await capture(() => ports.readPidfileIdentity(input.socketPath));
  if (!identityRead.ok) return blocked("identity-unavailable", identityRead.error);
  const identity = identityRead.value;
  if (identity === undefined) return blocked("identity-missing");
  if (
    identity.pid !== recoveryIdentity.pid ||
    identity.version !== recoveryIdentity.version ||
    identity.socketPath !== recoveryIdentity.socketPath
  ) {
    return blocked("identity-mismatch");
  }

  const before = verifyCooperativeObserverProcessIdentity(
    { source: "pidfile", identity },
    ports.processEvidence,
  );
  if (before.status === "mismatch") return blocked("identity-mismatch");
  if (before.status === "unavailable") {
    return blocked("identity-unavailable", inspectionError(before.cause));
  }
  const process = before.process;
  if (!hasExactProcessEvidence(process)) return blocked("identity-missing");

  const recoveryRead = await capture(() => ports.readRecoveryAssessment(recoveryIdentity));
  const currentStatus = await capture(ports.readStatus);
  const currentIdentityRead = await capture(() => ports.readPidfileIdentity(input.socketPath));
  const after = verifyCooperativeObserverProcessIdentity(
    { source: "process", process },
    ports.processEvidence,
  );
  if (!currentStatus.ok) return blocked("identity-drift", currentStatus.error);
  if (currentStatus.value.status !== "running") {
    return blocked("identity-drift", currentStatus.value.error);
  }
  const currentHealth = currentStatus.value.health;
  if (
    !hasExactHealthEvidence(currentHealth, input.socketPath) ||
    currentHealth.pid !== health.pid ||
    currentHealth.startedAt !== health.startedAt ||
    currentHealth.version !== health.version
  ) {
    return blocked("identity-drift");
  }

  if (!currentIdentityRead.ok) return blocked("identity-drift", currentIdentityRead.error);
  const currentIdentity = currentIdentityRead.value;
  if (currentIdentity === undefined || !observerProcessIdentitiesMatch(currentIdentity, identity)) {
    return blocked("identity-drift");
  }

  if (
    after.status === "mismatch" ||
    after.status === "unavailable" ||
    before.status !== after.status
  ) {
    return blocked(
      "identity-drift",
      after.status === "unavailable" ? inspectionError(after.cause) : undefined,
    );
  }
  const currentProcess = after.process;
  if (!hasExactProcessEvidence(currentProcess)) return blocked("identity-drift");

  return {
    status: "exact",
    health: currentHealth,
    processIdentity: currentIdentity,
    process: currentProcess,
    recovery: recoveryRead.ok
      ? { status: "assessed", assessment: recoveryRead.value }
      : { status: "unknown", error: recoveryRead.error },
  };
}

function hasExactHealthEvidence(
  health: ObserverHealth,
  socketPath: string,
): health is ExactObserverHealthEvidence {
  return (
    health.pid !== undefined &&
    health.startedAt !== undefined &&
    health.version !== undefined &&
    parseStationObserverBuildVersion(health.version).buildIdentity !== undefined &&
    health.socketPath === socketPath
  );
}

function hasExactProcessEvidence(
  process: ObserverCooperativeProcessEntry,
): process is ExactObserverProcessEvidence {
  return (
    process.socketPath !== undefined &&
    process.startupTimeoutMs !== undefined &&
    Number.isSafeInteger(process.startupTimeoutMs) &&
    process.startupTimeoutMs > 0
  );
}

async function inspectStopped(
  socketPath: string,
  ports: ExactObserverInspectionPorts,
): Promise<ExactObserverOwnershipEvidence> {
  const identityRead = await capture(() => ports.readPidfileIdentity(socketPath));
  if (!identityRead.ok) return blocked("identity-unavailable", identityRead.error);
  const identity = identityRead.value;
  if (identity === undefined) return { status: "absent" };
  if (identity.socketPath !== socketPath) return blocked("identity-mismatch");
  const verification = verifyCooperativeObserverProcessIdentity(
    { source: "pidfile", identity },
    ports.processEvidence,
  );
  if (verification.status === "mismatch") return blocked("identity-mismatch");
  if (verification.status === "unavailable") {
    return blocked("identity-unavailable", inspectionError(verification.cause));
  }
  return blocked("process-without-socket");
}

async function capture<T>(read: () => Promise<T>) {
  try {
    return { ok: true as const, value: await read() };
  } catch (cause) {
    return { ok: false as const, error: inspectionError(cause) };
  }
}

function blocked(
  reason: ExactObserverInspectionFailureReason,
  error?: SafeError,
): ExactObserverOwnershipEvidence {
  return error === undefined ? { status: "blocked", reason } : { status: "blocked", reason, error };
}

function inspectionError(cause: unknown): SafeError {
  return toSafeError(cause, {
    tag: "ObserverInspectionError",
    code: "OBSERVER_INSPECTION_FAILED",
    message: "Exact Observer ownership evidence could not be inspected.",
  });
}
