import {
  createLocalObserverProcessEvidence,
  createObserverBootClaimCleanupExclusion,
  createObserverReap,
  type ObserverDuplicateCleanupExclusion,
  type ObserverDuplicateProcessEvidenceSource,
  type ObserverReap,
  type ObserverReapOutcome as ReapOutcome,
  type ObserverReapTarget as ReapTarget,
  type ObserverProcessEntry as SharedObserverProcessEntry,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";

export type ObserverProcessEntry = SharedObserverProcessEntry;
export type { ReapOutcome, ReapTarget };

export type ObserverReapDeps = {
  listObserverProcesses?: () => ObserverProcessEntry[];
  socketHolders?: (socketPath: string) => number[];
  processStartToken?: (pid: number) => string | undefined;
  readProcessIdentity?: ObserverDuplicateProcessEvidenceSource["readProcessIdentity"];
  socketIdentity?: ObserverDuplicateProcessEvidenceSource["socketIdentity"];
  unixSocketFdCount?: ObserverDuplicateProcessEvidenceSource["unixSocketFdCount"];
  healthPid?: (socketPath: string) => Promise<number | undefined>;
  exclusion?: ObserverDuplicateCleanupExclusion;
  signal?: (pid: number, sig: NodeJS.Signals | 0) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * COMPOSITION ROOT
 *
 * Selects local process evidence and protocol health for explicit Observer reap.
 */
export function createLocalObserverReap(deps: ObserverReapDeps = {}): ObserverReap {
  const localEvidence = createLocalObserverProcessEvidence();
  const evidence: ObserverDuplicateProcessEvidenceSource = {
    listObserverProcesses: deps.listObserverProcesses ?? localEvidence.listObserverProcesses,
    socketHolders: deps.socketHolders ?? localEvidence.socketHolders,
    processStartToken: deps.processStartToken ?? localEvidence.processStartToken,
    readProcessIdentity: deps.readProcessIdentity ?? localEvidence.readProcessIdentity,
    socketIdentity: deps.socketIdentity ?? localEvidence.socketIdentity,
    unixSocketFdCount: deps.unixSocketFdCount ?? localEvidence.unixSocketFdCount,
    signal: observerSignal(deps.signal, localEvidence),
  };
  return (socketPath, options) =>
    createObserverReap({
      evidence,
      exclusion: deps.exclusion ?? createObserverBootClaimCleanupExclusion({ socketPath }),
      healthPid: deps.healthPid ?? defaultHealthPid,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })(socketPath, options);
}

/**
 * ADAPTER
 *
 * Translates a CLI reap request into the Observer-owned driving port.
 */
export function runObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number },
  reap: ObserverReap,
): Promise<ReapOutcome> {
  return reap(socketPath, options);
}

function observerSignal(
  signal: ObserverReapDeps["signal"],
  localEvidence: ObserverDuplicateProcessEvidenceSource,
): ObserverDuplicateProcessEvidenceSource["signal"] {
  if (signal === undefined) return localEvidence.signal;
  return (pid, requestedSignal) => (signal(pid, requestedSignal) === false ? "absent" : "sent");
}

async function defaultHealthPid(socketPath: string): Promise<number | undefined> {
  try {
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    const health = await client.health();
    return health.pid;
  } catch {
    return undefined;
  }
}
