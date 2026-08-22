import type { ObserverStaleEvidenceRepairSummary } from "@station/contracts";
import {
  acquireObserverBootClaim,
  createLocalObserverProcessEvidence,
  createLocalObserverProcessIdentityRepair,
  type ObserverProcessEvidenceSource,
  type ObserverProcessExistenceEvidenceSource,
  type ObserverProcessIdentityRepair,
  observerEvidenceOwnerChangedRefusal,
  probeObserverSocket,
  repairStaleObserverEvidence,
} from "@station/observer/internal";

const MIN_REPAIR_TIMEOUT_MS = 1;
const MAX_PROCESS_EVIDENCE_TIMEOUT_MS = 1_000;

export type RepairLocalObserverEvidence = (input: {
  socketPath: string;
  timeoutMs: number;
}) => Promise<ObserverStaleEvidenceRepairSummary>;

type LocalObserverEvidenceRepairDeps = {
  acquireClaim?: typeof acquireObserverBootClaim;
  processEvidence?: ObserverProcessEvidenceSource;
  processExistenceEvidence?: ObserverProcessExistenceEvidenceSource;
  identityRepair?: ObserverProcessIdentityRepair;
  probeSocket?: typeof probeObserverSocket;
  now?: () => number;
};

/**
 * COMPOSITION ROOT
 *
 * Joins the Observer boot claim, bounded local process evidence, strict pidfile
 * adapter, and socket probe for one CLI-requested stale-evidence repair.
 */
export async function repairLocalObserverEvidence(
  input: { socketPath: string; timeoutMs: number },
  deps: LocalObserverEvidenceRepairDeps = {},
): Promise<ObserverStaleEvidenceRepairSummary> {
  const now = deps.now ?? Date.now;
  const deadlineMs = now() + input.timeoutMs;
  const localEvidence =
    deps.processEvidence === undefined || deps.processExistenceEvidence === undefined
      ? createLocalObserverProcessEvidence({
          evidenceTimeoutMs: Math.max(
            MIN_REPAIR_TIMEOUT_MS,
            Math.min(MAX_PROCESS_EVIDENCE_TIMEOUT_MS, input.timeoutMs),
          ),
        })
      : undefined;
  const processEvidence = deps.processEvidence ?? localEvidence;
  const processExistenceEvidence = deps.processExistenceEvidence ?? localEvidence;
  if (processEvidence === undefined || processExistenceEvidence === undefined) {
    throw new Error("Observer evidence repair requires exact process evidence.");
  }

  const claim = await (deps.acquireClaim ?? acquireObserverBootClaim)({
    socketPath: input.socketPath,
    timeoutMs: remainingMs(deadlineMs, now),
  });
  if (claim.status !== "acquired") throw claim.error;

  let result: ObserverStaleEvidenceRepairSummary | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    const probeSocket = deps.probeSocket ?? probeObserverSocket;
    const probe = await probeSocket(input.socketPath, {
      timeoutMs: remainingMs(deadlineMs, now),
      socketHolders: (path: string) => processEvidence.socketHolders(path),
    });
    if (probe.status === "inaccessible") throw probe.error;
    if (probe.status === "listening") throw observerEvidenceOwnerChangedRefusal();

    result = await repairStaleObserverEvidence(
      {
        socketPath: input.socketPath,
        socketProbe: probe,
        deadlineMs,
      },
      {
        processEvidence: {
          readObserverProcess: processEvidence.readObserverProcess,
          processStartToken: processEvidence.processStartToken,
          readProcessExistence: processExistenceEvidence.readProcessExistence,
        },
        identityRepair: deps.identityRepair ?? createLocalObserverProcessIdentityRepair(),
        probeSocket: () =>
          probeSocket(input.socketPath, {
            timeoutMs: remainingMs(deadlineMs, now),
            socketHolders: (path: string) => processEvidence.socketHolders(path),
          }),
        now,
      },
    );
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const release = claim.release();
  if (operationFailed) throw operationError;
  if (release.status === "failed") throw release.error;
  if (result === undefined) throw new Error("Observer evidence repair did not produce a result.");
  return result;
}

function remainingMs(deadlineMs: number, now: () => number): number {
  return Math.max(MIN_REPAIR_TIMEOUT_MS, Math.floor(deadlineMs - now()));
}
