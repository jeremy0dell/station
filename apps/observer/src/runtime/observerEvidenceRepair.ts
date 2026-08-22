import type {
  ObserverProcessIdentity,
  ObserverStaleEvidenceRepairReason,
  ObserverStaleEvidenceRepairSummary,
  SafeError,
} from "@station/contracts";
import { ObserverStaleEvidenceRepairSummarySchema } from "@station/contracts";
import {
  type ObserverProcessExistenceEvidenceSource,
  type ObserverProcessIdentityEvidenceSource,
  type ObserverProcessIdentityRepair,
  observerProcessIdentitiesMatch,
  verifyObserverProcessIdentity,
} from "./observerProcessIdentity.js";
import type { SocketIdentity } from "./socketOwnership.js";

const MAX_REPAIR_ATTEMPTS = 2;

export type ObserverEvidenceSocketProbe =
  | { status: "absent" }
  | { status: "listening"; identity: SocketIdentity }
  | { status: "stale"; identity: SocketIdentity }
  | { status: "inaccessible"; error: SafeError };

export type ObserverRepairableSocketProbe = Extract<
  ObserverEvidenceSocketProbe,
  { status: "absent" | "stale" }
>;

export type ObserverStaleEvidenceRepairDeps = {
  processEvidence: ObserverProcessIdentityEvidenceSource & ObserverProcessExistenceEvidenceSource;
  identityRepair: ObserverProcessIdentityRepair;
  probeSocket: () => Promise<ObserverEvidenceSocketProbe>;
  now?: () => number;
};

/**
 * USE CASE
 *
 * Repairs positively stale pidfile evidence while the caller holds the Observer
 * boot claim. It revalidates process, pidfile, and socket evidence before the
 * atomic pidfile commit and never signals or unlinks a socket.
 */
export async function repairStaleObserverEvidence(
  input: {
    socketPath: string;
    socketProbe: ObserverRepairableSocketProbe;
    deadlineMs: number;
    signal?: AbortSignal;
  },
  deps: ObserverStaleEvidenceRepairDeps,
): Promise<ObserverStaleEvidenceRepairSummary> {
  const now = deps.now ?? Date.now;
  const admittedProbe = input.socketProbe;
  let baselineIdentity: ObserverProcessIdentity | null | undefined;

  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    requireRepairBudget(input, now);
    let admittedIdentity: ObserverProcessIdentity | undefined;
    try {
      admittedIdentity = await deps.identityRepair.read(input.socketPath);
    } catch {
      throw repairRefused(
        "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
        "Observer pidfile ownership could not be established safely.",
      );
    }
    if (baselineIdentity === undefined) {
      baselineIdentity = admittedIdentity ?? null;
    } else if (
      (baselineIdentity === null && admittedIdentity !== undefined) ||
      (baselineIdentity !== null &&
        (admittedIdentity === undefined ||
          !observerProcessIdentitiesMatch(admittedIdentity, baselineIdentity)))
    ) {
      throw observerEvidenceOwnerChangedRefusal();
    }

    if (admittedIdentity === undefined) {
      const currentIdentity = await deps.identityRepair.read(input.socketPath).catch(() => {
        throw repairRefused(
          "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
          "Observer pidfile ownership could not be revalidated safely.",
        );
      });
      const currentProbe = await deps.probeSocket();
      if (
        currentIdentity === undefined &&
        repairableSocketProbesMatch(admittedProbe, currentProbe)
      ) {
        return ObserverStaleEvidenceRepairSummarySchema.parse({
          socket: admittedProbe.status,
          pidfile: "absent",
        });
      }
      if (!isRepairableProbe(currentProbe)) throw socketChangedRefusal(currentProbe);
      throw observerEvidenceOwnerChangedRefusal();
    }

    const admittedClassification = classifyPidfile(admittedIdentity, deps.processEvidence);
    if (admittedClassification.status === "exact") throw exactProcessRefusal();
    if (admittedClassification.status === "uncertain") {
      throw repairRefused(
        "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
        "Observer process ownership could not be established safely.",
      );
    }

    requireRepairBudget(input, now);
    const currentIdentity = await deps.identityRepair.read(input.socketPath).catch(() => {
      throw repairRefused(
        "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
        "Observer pidfile ownership could not be revalidated safely.",
      );
    });
    if (
      currentIdentity === undefined ||
      !observerProcessIdentitiesMatch(currentIdentity, admittedIdentity)
    ) {
      throw observerEvidenceOwnerChangedRefusal();
    }

    const currentClassification = classifyPidfile(currentIdentity, deps.processEvidence);
    if (currentClassification.status === "exact") throw exactProcessRefusal();
    if (currentClassification.status === "uncertain") {
      throw repairRefused(
        "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
        "Observer process ownership could not be revalidated safely.",
      );
    }
    if (currentClassification.reason !== admittedClassification.reason) continue;

    const currentProbe = await deps.probeSocket();
    if (!repairableSocketProbesMatch(admittedProbe, currentProbe)) {
      if (!isRepairableProbe(currentProbe)) throw socketChangedRefusal(currentProbe);
      throw observerEvidenceOwnerChangedRefusal();
    }

    requireRepairBudget(input, now);
    let removed: boolean;
    try {
      // The adapter drains this atomic rename/compare/delete-or-restore commit
      // even if cancellation arrives after the call begins.
      removed = await deps.identityRepair.removeIfExact(currentIdentity);
    } catch {
      throw repairRefused(
        "OBSERVER_STALE_EVIDENCE_REPAIR_FAILED",
        "Stale Observer pidfile evidence could not be removed safely.",
      );
    }
    if (!removed) continue;
    return ObserverStaleEvidenceRepairSummarySchema.parse({
      socket: admittedProbe.status,
      pidfile: "removed",
      reason: currentClassification.reason,
    });
  }

  throw repairRefused(
    "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
    "Observer lifecycle evidence changed during repair.",
  );
}

type PidfileClassification =
  | { status: "exact" }
  | { status: "stale"; reason: ObserverStaleEvidenceRepairReason }
  | { status: "uncertain" };

function classifyPidfile(
  identity: ObserverProcessIdentity,
  evidence: ObserverStaleEvidenceRepairDeps["processEvidence"],
): PidfileClassification {
  const existence = evidence.readProcessExistence(identity.pid);
  if (existence.status === "absent") {
    return { status: "stale", reason: "process-missing" };
  }
  if (existence.status === "unavailable") {
    return { status: "uncertain" };
  }

  const verification = verifyObserverProcessIdentity({ source: "pidfile", identity }, evidence);
  if (verification.status === "exact") return { status: "exact" };
  if (verification.status === "mismatch") {
    return { status: "stale", reason: verification.reason };
  }
  return { status: "uncertain" };
}

function requireRepairBudget(
  input: { deadlineMs: number; signal?: AbortSignal },
  now: () => number,
): void {
  if (input.signal?.aborted === true) {
    throw repairRefused(
      "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
      "Observer evidence repair was cancelled before its commit point.",
    );
  }
  if (now() >= input.deadlineMs) {
    throw repairRefused(
      "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
      "Observer evidence repair exceeded its lifecycle deadline.",
    );
  }
}

function isRepairableProbe(
  probe: ObserverEvidenceSocketProbe,
): probe is ObserverRepairableSocketProbe {
  return probe.status === "absent" || probe.status === "stale";
}

function repairableSocketProbesMatch(
  expected: ObserverRepairableSocketProbe,
  current: ObserverEvidenceSocketProbe,
): boolean {
  if (expected.status === "absent") return current.status === "absent";
  return (
    current.status === "stale" &&
    current.identity.ino === expected.identity.ino &&
    current.identity.birthtimeNs === expected.identity.birthtimeNs
  );
}

function exactProcessRefusal(): Error & SafeError {
  return repairRefused(
    "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
    "The recorded Observer process still has exact live identity.",
  );
}

function socketChangedRefusal(probe: ObserverEvidenceSocketProbe): Error & SafeError {
  if (probe.status === "inaccessible") {
    return repairRefused(
      "OBSERVER_STALE_EVIDENCE_UNCERTAIN",
      "Observer socket ownership became inaccessible during repair.",
    );
  }
  return observerEvidenceOwnerChangedRefusal();
}

/** Builds the typed refusal used when a repair admission no longer names the current owner. */
export function observerEvidenceOwnerChangedRefusal(): Error & SafeError {
  return repairRefused(
    "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED",
    "Observer socket ownership changed during repair.",
  );
}

function repairRefused(code: string, message: string): Error & SafeError {
  const safeError: SafeError = {
    tag: "ObserverEvidenceRepairError",
    code,
    message,
    hint: "Inspect Observer status and exact ownership evidence before retrying.",
  };
  return Object.assign(new Error(message), safeError);
}
