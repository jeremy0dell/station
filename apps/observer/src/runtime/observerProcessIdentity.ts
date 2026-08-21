import type { ObserverProcessIdentity } from "@station/contracts";

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
  | { status: "mismatch"; reason: ObserverProcessIdentityMismatchReason }
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

    const process = evidence.readObserverProcess(identity.pid);
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
