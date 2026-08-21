import type { ObserverProcessIdentity } from "@station/contracts";
import { observerProcessIdentitiesMatch } from "./observerPidfile.js";
import {
  type ObserverProcessEntry,
  type ObserverProcessIdentityEvidenceSource,
  verifyObserverProcessIdentity,
} from "./observerProcessIdentity.js";
import type { SocketIdentity } from "./socketOwnership.js";

const DEFAULT_LEGACY_QUARANTINE_MS = 10_000;
const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const SIGKILL_CONFIRM_MS = 500;

/**
 * DRIVEN PORT
 *
 * Supplies strict process, socket-identity, pidfile, signal, and per-process
 * Unix-socket descriptor evidence for fail-closed global duplicate decisions.
 */
export interface ObserverDuplicateProcessEvidenceSource
  extends ObserverProcessIdentityEvidenceSource {
  socketHolders(socketPath: string): number[];
  readProcessIdentity(socketPath: string): Promise<ObserverProcessIdentity | undefined>;
  signal(pid: number, signal: NodeJS.Signals | 0): "sent" | "absent" | "refused";
  listObserverProcesses(): ObserverProcessEntry[];
  socketIdentity(socketPath: string): Promise<SocketIdentity | undefined>;
  unixSocketFdCount(process: ObserverProcessEntry): number;
}

export type ObserverReapExclusionResult<T> =
  | { status: "completed"; value: T; released: boolean }
  | { status: "busy" }
  | { status: "failed"; reason: string };

/**
 * DRIVEN PORT
 *
 * Authorizes explicit reap only while startup mutation is excluded, refusing
 * immediately when another boot owns the claim.
 */
export interface ObserverReapExclusion {
  runExclusive<T>(operation: () => Promise<T>): Promise<ObserverReapExclusionResult<T>>;
}

export type ObserverKeeperPreservation = {
  pid: boolean;
  socketIdentity: boolean;
  pidfile: boolean;
  preserved: boolean;
};

function inspectExactProcess(
  target: Pick<ObserverReapTarget, "pid" | "startToken" | "process">,
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): "same" | "absent" | "changed" | "unavailable" {
  try {
    const exists = evidence.signal(target.pid, 0);
    if (exists === "absent") return "absent";
    if (exists === "refused") return "unavailable";
    const verification = verifyObserverProcessIdentity(
      { source: "process", process: target.process },
      evidence,
    );
    if (verification.status === "exact" && verification.process.socketPath === socketPath) {
      return "same";
    }
    return verification.status === "mismatch" ? "changed" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export type ObserverReapAutomaticEligibility = {
  eligible: boolean;
  quarantineMs: number;
  refusalReasons: string[];
};

export type ObserverReapTarget = {
  pid: number;
  startToken: string;
  process: ObserverProcessEntry;
  automaticEligibility: ObserverReapAutomaticEligibility;
};

export type ObserverReapPlan = {
  socketPath: string;
  keeper?: number;
  targets: ObserverReapTarget[];
  refusals: { pid: number; reason: string }[];
  duplicates: number;
};

export type ObserverReapOutcome = {
  plan: ObserverReapPlan;
  applied: boolean;
  aborted?: string;
  killed: number[];
  exited: number[];
  survived: number[];
  keeperPreservation?: ObserverKeeperPreservation;
  claimReleased?: boolean;
};

export type RunObserverReapDeps = {
  evidence: ObserverDuplicateProcessEvidenceSource;
  exclusion: ObserverReapExclusion;
  healthPid: (socketPath: string) => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
};

export type ObserverDuplicateInspectionDeps = Pick<RunObserverReapDeps, "evidence" | "healthPid">;

/**
 * DRIVING PORT
 *
 * Accepts a local operator's dry-run or explicit-force duplicate reap request.
 */
export type ObserverReap = (
  socketPath: string,
  options?: { force: boolean; graceMs?: number },
) => Promise<ObserverReapOutcome>;

export function selectObserverReapPlan(input: {
  socketPath: string;
  processes: ObserverProcessEntry[];
  holders: number[];
  healthPid?: number;
}): ObserverReapPlan {
  const candidates = input.processes.filter((process) => process.socketPath === input.socketPath);
  const holderSet = new Set(input.holders);
  const refusals: { pid: number; reason: string }[] = [];
  let keeper: number | undefined;
  if (input.holders.length === 1) {
    keeper = input.holders[0];
  } else if (
    input.holders.length > 1 &&
    input.healthPid !== undefined &&
    holderSet.has(input.healthPid)
  ) {
    keeper = input.healthPid;
  }
  if (input.holders.length > 1) {
    for (const pid of input.holders) {
      if (pid !== keeper) refusals.push({ pid, reason: "unconfirmed socket holder" });
    }
  }
  const duplicates = candidates.filter((process) => process.pid !== keeper).length;
  if (keeper === undefined) {
    return { socketPath: input.socketPath, targets: [], refusals, duplicates };
  }
  const targets: ObserverReapTarget[] = [];
  for (const candidate of candidates) {
    if (candidate.pid === keeper || holderSet.has(candidate.pid)) continue;
    if (candidate.startToken.length === 0) {
      refusals.push({ pid: candidate.pid, reason: "no start-time token to re-verify" });
      continue;
    }
    targets.push({
      pid: candidate.pid,
      startToken: candidate.startToken,
      process: candidate,
      automaticEligibility: {
        eligible: false,
        quarantineMs: Math.max(
          DEFAULT_LEGACY_QUARANTINE_MS,
          candidate.startupTimeoutMs ?? DEFAULT_LEGACY_QUARANTINE_MS,
        ),
        refusalReasons: ["Automatic evidence has not been evaluated."],
      },
    });
  }
  const plan: ObserverReapPlan = {
    socketPath: input.socketPath,
    targets,
    refusals,
    duplicates,
  };
  plan.keeper = keeper;
  return plan;
}

/**
 * USE CASE
 *
 * Collects one read-only duplicate-process plan for startup diagnostics and
 * explicit reap without creating signal authority.
 */
export async function inspectObserverDuplicates(
  socketPath: string,
  deps: ObserverDuplicateInspectionDeps,
): Promise<ObserverReapPlan> {
  const processes = deps.evidence.listObserverProcesses();
  const holders = deps.evidence.socketHolders(socketPath);
  const healthPid = holders.length > 1 ? await deps.healthPid(socketPath) : undefined;
  const selectionInput: {
    socketPath: string;
    processes: ObserverProcessEntry[];
    holders: number[];
    healthPid?: number;
  } = { socketPath, processes, holders };
  if (healthPid !== undefined) selectionInput.healthPid = healthPid;
  return addAutomaticEligibility(selectObserverReapPlan(selectionInput), deps.evidence);
}

/**
 * USE CASE
 *
 * Creates explicit operator reap with centralized selection and revalidation;
 * only this manual force path may escalate from SIGTERM to SIGKILL.
 */
export function createObserverReap(deps: RunObserverReapDeps) {
  return (socketPath: string, options: { force: boolean; graceMs?: number } = { force: false }) =>
    runObserverReap(socketPath, options, deps);
}

async function runObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number } = { force: false },
  deps: RunObserverReapDeps,
): Promise<ObserverReapOutcome> {
  const plan = await inspectObserverDuplicates(socketPath, deps);
  if (!options.force || plan.keeper === undefined || plan.targets.length === 0) {
    return { plan, applied: false, killed: [], exited: [], survived: [] };
  }
  const keeper = plan.keeper;
  const excluded = await deps.exclusion.runExclusive(() =>
    applyObserverReap({ socketPath, options, plan, keeper, deps }),
  );
  if (excluded.status === "busy") {
    return abortedReapOutcome(plan, false, "boot-claim-busy");
  }
  if (excluded.status === "failed") {
    return abortedReapOutcome(plan, false, "boot-claim-failed");
  }
  return {
    ...excluded.value,
    ...(excluded.released
      ? { claimReleased: true }
      : {
          claimReleased: false,
          aborted: excluded.value.aborted ?? "boot-claim-release-failed",
        }),
  };
}

type ApplyObserverReapInput = {
  socketPath: string;
  options: { force: boolean; graceMs?: number };
  plan: ObserverReapPlan;
  keeper: number;
  deps: RunObserverReapDeps;
};

async function applyObserverReap(input: ApplyObserverReapInput): Promise<ObserverReapOutcome> {
  const { socketPath, options, plan, keeper, deps } = input;
  const sleep = deps.sleep ?? defaultSleep;
  let baseline: ManualKeeperBaseline | undefined;
  try {
    baseline = await captureManualKeeperBaseline(socketPath, keeper, deps.evidence, deps.healthPid);
  } catch {
    // The structured refusal avoids converting missing evidence into signal authority.
  }
  if (baseline === undefined) {
    return abortedReapOutcome(plan, false, "keeper-evidence-unavailable");
  }
  const signaled = new Set<number>();
  const killed: number[] = [];
  const exited: number[] = [];

  for (const target of plan.targets) {
    try {
      if (!(await manualKeeperMatches(socketPath, baseline, deps.evidence, deps.healthPid))) {
        return abortedReapOutcome(plan, signaled.size > 0, "owner-changed", killed, exited);
      }
      if (!manualTargetRemains(target, socketPath, keeper, deps.evidence)) {
        return abortedReapOutcome(plan, signaled.size > 0, "target-changed", killed, exited);
      }
      const result = deps.evidence.signal(target.pid, "SIGTERM");
      if (result === "refused") {
        return abortedReapOutcome(plan, signaled.size > 0, "signal-refused", killed, exited);
      }
      if (result === "absent") {
        exited.push(target.pid);
        return abortedReapOutcome(plan, signaled.size > 0, "target-exited", killed, exited);
      }
      signaled.add(target.pid);
    } catch {
      return abortedReapOutcome(plan, signaled.size > 0, "evidence-unavailable", killed, exited);
    }
  }
  await sleep(options.graceMs ?? DEFAULT_SIGTERM_GRACE_MS);
  for (const target of plan.targets) {
    if (!signaled.has(target.pid)) continue;
    try {
      const state = inspectExactProcess(target, socketPath, deps.evidence);
      if (state === "absent") {
        killed.push(target.pid);
        continue;
      }
      if (state !== "same") {
        return abortedReapOutcome(
          plan,
          true,
          state === "changed" ? "target-changed" : "evidence-unavailable",
          killed,
          exited,
        );
      }
      if (!(await manualKeeperMatches(socketPath, baseline, deps.evidence, deps.healthPid))) {
        return abortedReapOutcome(plan, true, "owner-changed", killed, exited);
      }
      if (!manualTargetRemains(target, socketPath, keeper, deps.evidence)) {
        return abortedReapOutcome(plan, true, "target-changed", killed, exited);
      }
      const result = deps.evidence.signal(target.pid, "SIGKILL");
      if (result === "refused") {
        return abortedReapOutcome(plan, true, "signal-refused", killed, exited);
      }
      if (result === "absent") exited.push(target.pid);
    } catch {
      return abortedReapOutcome(plan, true, "evidence-unavailable", killed, exited);
    }
  }
  await sleep(SIGKILL_CONFIRM_MS);

  const remainingTargets = plan.targets.filter(
    (target) =>
      signaled.has(target.pid) && !killed.includes(target.pid) && !exited.includes(target.pid),
  );
  let classified: { killed: number[]; survived: number[] };
  let keeperPreservation: ObserverKeeperPreservation;
  try {
    classified = classifyManualReapTargets(remainingTargets, socketPath, deps.evidence);
    keeperPreservation = await inspectManualKeeperPreservation(
      socketPath,
      baseline,
      deps.evidence,
      deps.healthPid,
    );
  } catch {
    return abortedReapOutcome(plan, true, "evidence-unavailable", killed, exited);
  }
  killed.push(...classified.killed);
  return {
    plan,
    applied: true,
    killed,
    exited,
    survived: classified.survived,
    keeperPreservation,
  };
}

function abortedReapOutcome(
  plan: ObserverReapPlan,
  applied: boolean,
  aborted: string,
  killed: number[] = [],
  exited: number[] = [],
): ObserverReapOutcome {
  return { plan, applied, aborted, killed, exited, survived: [] };
}

function manualTargetRemains(
  target: ObserverReapTarget,
  socketPath: string,
  keeper: number,
  evidence: ObserverDuplicateProcessEvidenceSource,
): boolean {
  const holders = evidence.socketHolders(socketPath);
  return (
    holders.length === 1 &&
    holders[0] === keeper &&
    verifyObserverProcessIdentity({ source: "process", process: target.process }, evidence)
      .status === "exact" &&
    evidence.unixSocketFdCount(target.process) === 0 &&
    target.process.socketPath === socketPath
  );
}

function classifyManualReapTargets(
  targets: ObserverReapTarget[],
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): { killed: number[]; survived: number[] } {
  const killed: number[] = [];
  const survived: number[] = [];
  for (const target of targets) {
    const state = inspectExactProcess(target, socketPath, evidence);
    if (state === "absent") killed.push(target.pid);
    else if (state === "same") survived.push(target.pid);
    else throw new Error(`Target ${target.pid} could not be classified after SIGKILL.`);
  }
  return { killed, survived };
}

async function addAutomaticEligibility(
  plan: ObserverReapPlan,
  evidence: ObserverDuplicateProcessEvidenceSource,
): Promise<ObserverReapPlan> {
  if (plan.keeper === undefined || plan.targets.length === 0) return plan;
  const [pidfile, socketIdentity] = await Promise.all([
    evidence.readProcessIdentity(plan.socketPath),
    evidence.socketIdentity(plan.socketPath),
  ]);
  if (pidfile === undefined || pidfile.pid !== plan.keeper || socketIdentity === undefined) {
    return {
      ...plan,
      targets: plan.targets.map((target) => ({
        ...target,
        automaticEligibility: {
          ...target.automaticEligibility,
          refusalReasons: ["Keeper pidfile or socket identity evidence is unavailable."],
        },
      })),
    };
  }

  const holders = evidence.socketHolders(plan.socketPath);
  const keeperExact =
    pidfile.socketPath === plan.socketPath &&
    holders.length === 1 &&
    holders[0] === plan.keeper &&
    verifyObserverProcessIdentity({ source: "pidfile", identity: pidfile }, evidence).status ===
      "exact";
  return {
    ...plan,
    targets: plan.targets.map((target) => {
      let fdCount: number | undefined;
      try {
        fdCount = evidence.unixSocketFdCount(target.process);
      } catch {
        // Unavailable descriptor evidence cannot authorize a future signal.
      }
      const refusalReasons: string[] = [];
      if (!keeperExact) refusalReasons.push("The keeper's process evidence does not agree.");
      if (fdCount === undefined) {
        refusalReasons.push("The candidate's Unix-socket descriptor evidence is unavailable.");
      } else if (fdCount !== 0) {
        refusalReasons.push(`The candidate owns ${fdCount} Unix-socket descriptor(s).`);
      }
      return {
        ...target,
        automaticEligibility: {
          ...target.automaticEligibility,
          eligible: refusalReasons.length === 0,
          refusalReasons,
        },
      };
    }),
  };
}

type ManualKeeperBaseline = {
  keeper: number;
  startToken: string;
  socketIdentity: SocketIdentity;
  pidfile: ObserverProcessIdentity;
  process: ObserverProcessEntry;
};

async function captureManualKeeperBaseline(
  socketPath: string,
  keeper: number,
  evidence: ObserverDuplicateProcessEvidenceSource,
  healthPid: (socketPath: string) => Promise<number | undefined>,
): Promise<ManualKeeperBaseline | undefined> {
  const [pidfile, socketIdentity, healthyPid] = await Promise.all([
    evidence.readProcessIdentity(socketPath),
    evidence.socketIdentity(socketPath),
    healthPid(socketPath),
  ]);
  const holders = evidence.socketHolders(socketPath);
  const verification =
    pidfile === undefined
      ? undefined
      : verifyObserverProcessIdentity({ source: "pidfile", identity: pidfile }, evidence);
  if (
    pidfile === undefined ||
    socketIdentity === undefined ||
    verification?.status !== "exact" ||
    healthyPid !== keeper ||
    holders.length !== 1 ||
    holders[0] !== keeper ||
    pidfile.pid !== keeper ||
    pidfile.socketPath !== socketPath
  ) {
    return undefined;
  }
  return {
    keeper,
    startToken: pidfile.osStartTime,
    socketIdentity,
    pidfile,
    process: verification.process,
  };
}

async function manualKeeperMatches(
  socketPath: string,
  baseline: ManualKeeperBaseline,
  evidence: ObserverDuplicateProcessEvidenceSource,
  healthPid: (socketPath: string) => Promise<number | undefined>,
): Promise<boolean> {
  const [pidfile, socketIdentity, healthyPid] = await Promise.all([
    evidence.readProcessIdentity(socketPath),
    evidence.socketIdentity(socketPath),
    healthPid(socketPath),
  ]);
  const holders = evidence.socketHolders(socketPath);
  return (
    holders.length === 1 &&
    holders[0] === baseline.keeper &&
    healthyPid === baseline.keeper &&
    verifyObserverProcessIdentity({ source: "process", process: baseline.process }, evidence)
      .status === "exact" &&
    socketIdentitiesMatch(socketIdentity, baseline.socketIdentity) &&
    pidfile !== undefined &&
    observerProcessIdentitiesMatch(pidfile, baseline.pidfile)
  );
}

async function inspectManualKeeperPreservation(
  socketPath: string,
  baseline: ManualKeeperBaseline,
  evidence: ObserverDuplicateProcessEvidenceSource,
  healthPid: (socketPath: string) => Promise<number | undefined>,
): Promise<ObserverKeeperPreservation> {
  const [pidfile, socketIdentity, healthyPid] = await Promise.all([
    evidence.readProcessIdentity(socketPath),
    evidence.socketIdentity(socketPath),
    healthPid(socketPath),
  ]);
  const holders = evidence.socketHolders(socketPath);
  const pid =
    holders.length === 1 &&
    holders[0] === baseline.keeper &&
    healthyPid === baseline.keeper &&
    verifyObserverProcessIdentity({ source: "process", process: baseline.process }, evidence)
      .status === "exact";
  const preservedSocket = socketIdentitiesMatch(socketIdentity, baseline.socketIdentity);
  const preservedPidfile =
    pidfile !== undefined && observerProcessIdentitiesMatch(pidfile, baseline.pidfile);
  return {
    pid,
    socketIdentity: preservedSocket,
    pidfile: preservedPidfile,
    preserved: pid && preservedSocket && preservedPidfile,
  };
}

function socketIdentitiesMatch(
  actual: SocketIdentity | undefined,
  expected: SocketIdentity,
): boolean {
  return (
    actual !== undefined &&
    actual.ino === expected.ino &&
    actual.birthtimeNs === expected.birthtimeNs
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
