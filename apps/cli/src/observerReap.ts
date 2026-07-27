import {
  createLocalObserverProcessEvidence,
  type ObserverDuplicateProcessEvidenceSource,
  parseObserverProcessList,
  type ObserverReapOutcome as ReapOutcome,
  type ObserverReapPlan as ReapPlan,
  type ObserverReapTarget as ReapTarget,
  runObserverReap as runCentralObserverReap,
  type ObserverProcessEntry as SharedObserverProcessEntry,
  selectObserverReapPlan,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";

export type ObserverProcessEntry = SharedObserverProcessEntry;
export type { ReapOutcome, ReapPlan, ReapTarget };

export type ObserverReapDeps = {
  listObserverProcesses?: () => ObserverProcessEntry[];
  socketHolders?: (socketPath: string) => number[];
  processStartToken?: (pid: number) => string | undefined;
  readProcessIdentity?: ObserverDuplicateProcessEvidenceSource["readProcessIdentity"];
  socketIdentity?: ObserverDuplicateProcessEvidenceSource["socketIdentity"];
  unixSocketFdCount?: ObserverDuplicateProcessEvidenceSource["unixSocketFdCount"];
  healthPid?: (socketPath: string) => Promise<number | undefined>;
  signal?: (pid: number, sig: NodeJS.Signals | 0) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export const selectReapPlan = selectObserverReapPlan;

/**
 * ADAPTER
 *
 * Supplies protocol health and local operating-system evidence to the
 * Observer-owned explicit reap use case.
 */
export async function runObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number } = { force: false },
  deps: ObserverReapDeps = {},
): Promise<ReapOutcome> {
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
  const centralOptions: { force: boolean; graceMs?: number } = { force: options.force };
  if (options.graceMs !== undefined) centralOptions.graceMs = options.graceMs;
  return runCentralObserverReap(socketPath, centralOptions, {
    evidence,
    healthPid: deps.healthPid ?? defaultHealthPid,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
}

export const parseObserverPsOutput = parseObserverProcessList;

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
