import type {
  ObserverProcessEntry,
  ObserverProcessIdentityExpectation,
  ObserverProcessIdentityVerification,
} from "./observerProcessIdentity.js";
import { verifyObserverProcessIdentity } from "./observerProcessIdentity.js";

/** Exact process evidence with cooperative executable-replacement provenance. */
export type ObserverCooperativeProcessEntry = ObserverProcessEntry & {
  readonly executableProvenance: "exact" | "installed-path-replaced";
};

type CooperativeProcessIdentityVerification =
  | Exclude<ObserverProcessIdentityVerification, { status: "exact" }>
  | {
      readonly status: ObserverCooperativeProcessEntry["executableProvenance"];
      readonly process: ObserverCooperativeProcessEntry;
    };

/**
 * DRIVEN PORT
 *
 * Supplies cooperative provenance without lifecycle authority or generic-reader exposure.
 */
export interface ObserverCooperativeProcessEvidenceSource {
  readCooperativeObserverProcess(pid: number): ObserverCooperativeProcessEntry | undefined;
  processStartToken(pid: number): string | undefined;
}

/**
 * USE CASE
 *
 * Verifies cooperative provenance through the canonical exact identity policy.
 */
export function verifyCooperativeObserverProcessIdentity(
  expected: ObserverProcessIdentityExpectation,
  evidence: ObserverCooperativeProcessEvidenceSource,
): CooperativeProcessIdentityVerification {
  let process: ObserverCooperativeProcessEntry | undefined;
  const verification = verifyObserverProcessIdentity(expected, {
    readObserverProcess: (pid) => (process = evidence.readCooperativeObserverProcess(pid)),
    processStartToken: (pid) => evidence.processStartToken(pid),
  });
  if (verification.status !== "exact") return verification;
  if (process === undefined) return { status: "unavailable" };
  return { status: process.executableProvenance, process };
}
