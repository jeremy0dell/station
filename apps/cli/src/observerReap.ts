import {
  createLocalObserverProcessEvidence,
  type ObserverProcessEntry,
} from "@station/observer/internal";
import { createObserverClient } from "@station/protocol";

export type ReapTarget = { pid: number; startToken: string };

export type ReapPlan = {
  socketPath: string;
  keeper?: number;
  targets: ReapTarget[];
  /** Bound holders we refuse to signal (cannot prove they are not the current binder). */
  refusals: { pid: number; reason: string }[];
  /** Same-socket observers beyond the keeper (the duplicate count). */
  duplicates: number;
};

export type ObserverReapDeps = {
  listObserverProcesses?: () => ObserverProcessEntry[];
  socketHolders?: (socketPath: string) => number[];
  processStartToken?: (pid: number) => string | undefined;
  healthPid?: (socketPath: string) => Promise<number | undefined>;
  signal?: (pid: number, sig: NodeJS.Signals | 0) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const SIGTERM_GRACE_MS = 3000;
const SIGKILL_CONFIRM_MS = 500;

/**
 * Pure selection: who can be safely reaped for `socketPath`. Reaping requires a
 * single, identifiable live binder (the keeper); anything else refuses so the
 * caller never signals the wrong process. Every bound holder that is not the
 * confirmed keeper is refused, never targeted.
 */
export function selectReapPlan(input: {
  socketPath: string;
  processes: ObserverProcessEntry[];
  holders: number[];
  healthPid?: number | undefined;
}): ReapPlan {
  const candidates = input.processes.filter((p) => p.socketPath === input.socketPath);
  const holderSet = new Set(input.holders);
  const refusals: { pid: number; reason: string }[] = [];

  let keeper: number | undefined;
  if (input.holders.length === 1) {
    keeper = input.holders[0];
  } else if (input.holders.length > 1) {
    // Ambiguous binder: only the holder answering health is the keeper; the rest
    // are bound and unexplained, so they are refused rather than targeted.
    if (input.healthPid !== undefined && holderSet.has(input.healthPid)) {
      keeper = input.healthPid;
    }
    for (const pid of input.holders) {
      if (pid !== keeper) refusals.push({ pid, reason: "unconfirmed socket holder" });
    }
  }

  const duplicates = candidates.filter((p) => p.pid !== keeper).length;

  // With no confirmed keeper, refuse the whole reap: there is no anchor proving
  // which process legitimately owns the socket.
  if (keeper === undefined) {
    return { socketPath: input.socketPath, targets: [], refusals, duplicates };
  }

  const targets: ReapTarget[] = [];
  for (const p of candidates) {
    if (p.pid === keeper || holderSet.has(p.pid)) continue;
    if (p.startToken.length === 0) {
      refusals.push({ pid: p.pid, reason: "no start-time token to re-verify" });
      continue;
    }
    targets.push({ pid: p.pid, startToken: p.startToken });
  }
  return { socketPath: input.socketPath, keeper, targets, refusals, duplicates };
}

export type ReapOutcome = {
  plan: ReapPlan;
  applied: boolean;
  aborted?: string;
  killed: number[];
  survived: number[];
};

export async function runObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number } = { force: false },
  deps: ObserverReapDeps = {},
): Promise<ReapOutcome> {
  const localEvidence = createLocalObserverProcessEvidence();
  const list = deps.listObserverProcesses ?? localEvidence.listObserverProcesses;
  const holdersOf = deps.socketHolders ?? localEvidence.socketHolders;
  const tokenOf = deps.processStartToken ?? localEvidence.processStartToken;
  const kill =
    deps.signal ??
    ((pid: number, signal: NodeJS.Signals | 0) => localEvidence.signal(pid, signal) !== "absent");
  const sleep = deps.sleep ?? defaultSleep;
  const graceMs = options.graceMs ?? SIGTERM_GRACE_MS;

  const processes = list();
  const holders = holdersOf(socketPath);
  const healthPid =
    holders.length > 1 ? await (deps.healthPid ?? defaultHealthPid)(socketPath) : undefined;
  const plan = selectReapPlan({ socketPath, processes, holders, healthPid });

  if (!options.force || plan.keeper === undefined || plan.targets.length === 0) {
    return { plan, applied: false, killed: [], survived: [] };
  }

  const keeper = plan.keeper;
  // Owner set captured now; a change during the reap aborts it (a takeover is in flight).
  const ownerBaseline = holders.slice().sort().join(",");
  const ownerChanged = () => holdersOf(socketPath).slice().sort().join(",") !== ownerBaseline;

  const stillTarget = (t: ReapTarget): boolean => {
    if (holdersOf(socketPath).includes(t.pid)) return false; // became a binder
    const token = tokenOf(t.pid);
    return token !== undefined && token === t.startToken; // gone or PID-reused
  };

  const killed: number[] = [];
  for (const t of plan.targets) {
    if (ownerChanged())
      return { plan, applied: true, aborted: "owner-changed", killed, survived: [] };
    if (stillTarget(t)) kill(t.pid, "SIGTERM");
  }
  await sleep(graceMs);
  for (const t of plan.targets) {
    if (!kill(t.pid, 0)) continue; // already gone
    if (ownerChanged())
      return { plan, applied: true, aborted: "owner-changed", killed, survived: [] };
    if (stillTarget(t)) kill(t.pid, "SIGKILL");
  }
  await sleep(SIGKILL_CONFIRM_MS);

  const survived: number[] = [];
  for (const t of plan.targets) {
    if (kill(t.pid, 0)) survived.push(t.pid);
    else killed.push(t.pid);
  }
  // Keeper must be untouched.
  void keeper;
  return { plan, applied: true, killed, survived };
}

async function defaultHealthPid(socketPath: string): Promise<number | undefined> {
  try {
    const client = createObserverClient({ socketPath, timeoutMs: 1000 });
    const health = await client.health();
    return typeof health.pid === "number" ? health.pid : undefined;
  } catch {
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
