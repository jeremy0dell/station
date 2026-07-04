import { execFileSync } from "node:child_process";
import { resolveObserverSocketForProcessArgs } from "@station/config";
import { createObserverClient } from "@station/protocol";

export type ObserverProcessEntry = {
  pid: number;
  argv: string[];
  /** OS start-time token (ps lstart), compared verbatim to guard against PID reuse. */
  startToken: string;
  /** Socket the process would bind, resolved from its argv; undefined if unresolvable. */
  socketPath?: string;
};

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
  const list = deps.listObserverProcesses ?? defaultListObserverProcesses;
  const holdersOf = deps.socketHolders ?? defaultSocketHolders;
  const tokenOf = deps.processStartToken ?? defaultProcessStartToken;
  const kill = deps.signal ?? defaultSignal;
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

// --- default seams (macOS/Linux; ps/lsof/kill) ---

const LSTART_RE = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/;

export function parseObserverPsOutput(output: string): ObserverProcessEntry[] {
  const entries: ObserverProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = LSTART_RE.exec(line);
    if (match === null) continue;
    const [, pidStr, tokenStr, command] = match;
    if (pidStr === undefined || tokenStr === undefined || command === undefined) continue;
    const pid = Number(pidStr);
    const startToken = tokenStr.trim();
    const argv = command.split(/\s+/).filter((token) => token.length > 0);
    // Real observer only: argv[0] is a node binary running a …/observerMain.js
    // script. Shell wrappers (/bin/zsh -c '…observerMain…') are excluded because
    // their argv[0] is a shell, so grep/ps tooling never matches itself.
    const exe = argv[0] ?? "";
    const isNode = exe === "node" || exe.endsWith("/node");
    const runsObserver = argv.some((token) => token.endsWith("observerMain.js"));
    if (!Number.isInteger(pid) || !isNode || !runsObserver) continue;
    const socketPath = resolveObserverSocketForProcessArgs(argv);
    entries.push(
      socketPath === undefined ? { pid, argv, startToken } : { pid, argv, startToken, socketPath },
    );
  }
  return entries;
}

function defaultListObserverProcesses(): ObserverProcessEntry[] {
  const output = execFileSync("ps", ["-axww", "-o", "pid=,lstart=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseObserverPsOutput(output);
}

function defaultSocketHolders(socketPath: string): number[] {
  try {
    const out = execFileSync("lsof", ["-t", socketPath], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // lsof exits non-zero when nobody holds the socket
  }
}

function defaultProcessStartToken(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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

function defaultSignal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (error) {
    // ESRCH: gone. EPERM: exists but not ours — treat as present, never as reaped.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
