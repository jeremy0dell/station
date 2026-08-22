import type { ObserverProcessIdentity } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

export type ObserverProcessEntry = {
  pid: number;
  argv: string[];
  /** Executable path corroborated against the OS process image. */
  executablePath: string;
  /** Verbatim OS start time; second-resolution output is never sufficient alone. */
  startToken: string;
  /** Per-launch nonce that prevents same-second PID reuse from inheriting authority. */
  processToken: string;
  /** Immutable Observer build selector advertised by the child and checked at startup. */
  buildVersion: string;
  /** Resolved bound socket; absent when argv cannot prove one. */
  socketPath?: string;
  /** Positive startup exclusion budget advertised by current Observer argv. */
  startupTimeoutMs?: number;
};

/**
 * DRIVEN PORT
 *
 * Supplies exact, read-only Observer process evidence without exposing the
 * operating-system commands used to collect it.
 */
export interface ObserverProcessIdentityEvidenceSource {
  readObserverProcess(pid: number): ObserverProcessEntry | undefined;
  processStartToken(pid: number): string | undefined;
}

export type ObserverProcessExistence =
  | { status: "running"; osStartTime: string }
  | { status: "absent" }
  | { status: "unavailable"; cause?: unknown };

/** DRIVEN PORT: Supplies bounded, read-only process existence evidence without signaling. */
export interface ObserverProcessExistenceEvidenceSource {
  readProcessExistence(pid: number): ObserverProcessExistence;
}

/** DRIVEN PORT: Reads and atomically removes only an exact strict Observer pidfile identity. */
export interface ObserverProcessIdentityRepair {
  read(socketPath: string): Promise<ObserverProcessIdentity | undefined>;
  removeIfExact(identity: ObserverProcessIdentity): Promise<boolean>;
}

export type ObserverProcessIdentityExpectation =
  | { source: "pidfile"; identity: ObserverProcessIdentity }
  | { source: "process"; process: ObserverProcessEntry };

export type ObserverProcessIdentityMismatchReason =
  | "os-start-token-drift"
  | "executable-argv-drift"
  | "process-token-drift"
  | "build-version-drift"
  | "socket-argv-drift";

export type ObserverProcessIdentityVerification =
  | { status: "exact"; process: ObserverProcessEntry }
  | { status: "mismatch"; reason: ObserverProcessIdentityMismatchReason; cause?: unknown }
  | { status: "unavailable"; cause?: unknown };

/** Compares the complete evidence for one exact Observer process generation. */
export function observerProcessEntriesMatch(
  left: ObserverProcessEntry,
  right: ObserverProcessEntry,
): boolean {
  return (
    left.pid === right.pid &&
    left.executablePath === right.executablePath &&
    left.startToken === right.startToken &&
    left.processToken === right.processToken &&
    left.buildVersion === right.buildVersion &&
    left.socketPath === right.socketPath &&
    left.startupTimeoutMs === right.startupTimeoutMs &&
    left.argv.length === right.argv.length &&
    left.argv.every((value, index) => value === right.argv[index])
  );
}

/** Compares every field of a strict Observer pidfile identity. */
export function observerProcessIdentitiesMatch(
  actual: ObserverProcessIdentity,
  expected: ObserverProcessIdentity,
): boolean {
  return (
    actual.pid === expected.pid &&
    actual.osStartTime === expected.osStartTime &&
    actual.processToken === expected.processToken &&
    actual.version === expected.version &&
    actual.socketPath === expected.socketPath
  );
}

/**
 * USE CASE
 *
 * Verifies one exact Observer process generation from read-only evidence. The
 * caller decides whether an exact, mismatched, or unavailable result permits a
 * lifecycle action; the verifier never creates signal authority.
 */
export function verifyObserverProcessIdentity(
  expected: ObserverProcessIdentityExpectation,
  evidence: ObserverProcessIdentityEvidenceSource,
): ObserverProcessIdentityVerification {
  const identity = normalizeExpectedIdentity(expected);
  try {
    const osStartTime = evidence.processStartToken(identity.pid);
    if (osStartTime === undefined) return { status: "unavailable" };
    if (osStartTime !== identity.osStartTime) {
      return { status: "mismatch", reason: "os-start-token-drift" };
    }

    let process: ObserverProcessEntry | undefined;
    try {
      process = evidence.readObserverProcess(identity.pid);
    } catch (cause) {
      const normalized = safeErrorFromUnknown(cause, {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EVIDENCE_UNAVAILABLE",
        message: "Observer process evidence was unavailable.",
      });
      if (normalized.code === "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH") {
        return { status: "mismatch", reason: "executable-argv-drift", cause };
      }
      return { status: "unavailable", cause };
    }
    if (process === undefined) {
      return { status: "mismatch", reason: "executable-argv-drift" };
    }
    if (process.startToken !== identity.osStartTime) {
      return { status: "mismatch", reason: "os-start-token-drift" };
    }
    if (process.processToken !== identity.processToken) {
      return { status: "mismatch", reason: "process-token-drift" };
    }
    if (process.buildVersion !== identity.version) {
      return { status: "mismatch", reason: "build-version-drift" };
    }
    if (process.socketPath !== identity.socketPath) {
      return { status: "mismatch", reason: "socket-argv-drift" };
    }
    if (expected.source === "process" && !observerProcessEntriesMatch(process, expected.process)) {
      return { status: "mismatch", reason: "executable-argv-drift" };
    }
    return { status: "exact", process };
  } catch (cause) {
    return { status: "unavailable", cause };
  }
}

function normalizeExpectedIdentity(
  expected: ObserverProcessIdentityExpectation,
): ObserverProcessIdentity {
  if (expected.source === "pidfile") return expected.identity;
  return {
    pid: expected.process.pid,
    osStartTime: expected.process.startToken,
    processToken: expected.process.processToken,
    version: expected.process.buildVersion,
    socketPath: expected.process.socketPath ?? "",
  };
}
