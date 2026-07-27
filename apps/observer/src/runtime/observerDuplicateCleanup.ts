import type { ObserverProcessIdentity } from "@station/contracts";
import type { ObserverProcessEntry, ObserverProcessEvidenceSource } from "./observerHandoff.js";
import { observerProcessIdentitiesMatch } from "./observerPidfile.js";
import type { SocketIdentity } from "./socketOwnership.js";

const DEFAULT_LEGACY_QUARANTINE_MS = 10_000;
const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const SIGKILL_CONFIRM_MS = 500;

export type ObserverDuplicateCleanupRefusal = {
  pid?: number;
  code: string;
  reason: string;
};

export type ObserverDuplicateCleanupTarget = {
  pid: number;
  startToken: string;
  startupTimeoutMs?: number;
  quarantineMs: number;
};

export type ObserverDuplicateCleanupPlan = {
  socketPath: string;
  duplicates: number;
  eligibleTargets: ObserverDuplicateCleanupTarget[];
  refusals: ObserverDuplicateCleanupRefusal[];
};

export type ObserverDuplicateCleanupPlanInput = {
  socketPath: string;
  keeperIdentity: ObserverProcessIdentity;
  boundSocketIdentity: SocketIdentity;
  currentSocketIdentity?: SocketIdentity;
  holders: number[];
  keeperStartToken?: string;
  currentPidfile?: ObserverProcessIdentity;
  processes: ObserverProcessEntry[];
  candidateUnixSocketFdCounts: ReadonlyMap<number, number>;
  legacyQuarantineMs: number;
};

/**
 * DRIVEN PORT
 *
 * Supplies strict process, socket-identity, pidfile, signal, and per-process
 * Unix-socket descriptor evidence for duplicate Observer decisions.
 */
export interface ObserverDuplicateProcessEvidenceSource extends ObserverProcessEvidenceSource {
  socketIdentity(socketPath: string): Promise<SocketIdentity | undefined>;
  unixSocketFdCount(pid: number): number;
}

export type ObserverDuplicateCleanupExclusionResult<T> =
  | { status: "completed"; value: T; released: boolean }
  | { status: "busy" }
  | { status: "failed"; reason: string };

/**
 * DRIVEN PORT
 *
 * Authorizes final duplicate cleanup only while startup mutation is excluded,
 * refusing immediately when another boot owns the claim.
 */
export interface ObserverDuplicateCleanupExclusion {
  runExclusive<T>(operation: () => Promise<T>): Promise<ObserverDuplicateCleanupExclusionResult<T>>;
}

export type ObserverKeeperPreservation = {
  pid: boolean;
  socketIdentity: boolean;
  pidfile: boolean;
  preserved: boolean;
};

export type ObserverDuplicateCleanupOutcome = {
  socketPath: string;
  status:
    | "pending"
    | "running"
    | "clear"
    | "refused"
    | "would-terminate"
    | "terminated"
    | "survived"
    | "cancelled";
  eligiblePids: number[];
  refusalCodes: string[];
  refusals: ObserverDuplicateCleanupRefusal[];
  terminatedPids: number[];
  survivedPids: number[];
  keeperPreservation?: ObserverKeeperPreservation;
  claimReleased?: boolean;
};

export type ObserverDuplicateCleanup = {
  run(): Promise<ObserverDuplicateCleanupOutcome>;
  abort(): void;
  status(): ObserverDuplicateCleanupOutcome;
};

type ObserverDuplicateCleanupOptions = {
  socketPath: string;
  keeperIdentity: ObserverProcessIdentity;
  boundSocketIdentity: SocketIdentity;
  mode: "report" | "terminate";
  legacyQuarantineMs?: number;
  exitGraceMs?: number;
};

type ObserverDuplicateCleanupDeps = {
  evidence: ObserverDuplicateProcessEvidenceSource;
  exclusion: ObserverDuplicateCleanupExclusion;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type AutomaticInspection = {
  plan: ObserverDuplicateCleanupPlan;
  processes: ObserverProcessEntry[];
};

/**
 * POLICY
 *
 * Selects duplicate Observers only when the keeper's immutable identity is
 * exact and each candidate has no Unix-domain socket descriptors.
 */
export function selectObserverDuplicateCleanupPlan(
  input: ObserverDuplicateCleanupPlanInput,
): ObserverDuplicateCleanupPlan {
  const candidates = input.processes.filter(
    (entry) => entry.pid !== input.keeperIdentity.pid && entry.socketPath === input.socketPath,
  );
  const refusals = keeperEvidenceRefusals(input);
  const keeperRefused = refusals.length > 0;
  const eligibleTargets: ObserverDuplicateCleanupTarget[] = [];
  for (const candidate of candidates) {
    const selection = selectAutomaticCandidate(input, candidate);
    if ("refusal" in selection) {
      refusals.push(selection.refusal);
    } else if (!keeperRefused) {
      eligibleTargets.push(selection.target);
    }
  }

  return {
    socketPath: input.socketPath,
    duplicates: candidates.length,
    eligibleTargets,
    refusals,
  };
}

function keeperEvidenceRefusals(
  input: ObserverDuplicateCleanupPlanInput,
): ObserverDuplicateCleanupRefusal[] {
  const refusals: ObserverDuplicateCleanupRefusal[] = [];
  const keeperProcess = input.processes.find((entry) => entry.pid === input.keeperIdentity.pid);
  if (!socketIdentitiesMatch(input.currentSocketIdentity, input.boundSocketIdentity)) {
    refusals.push(
      refusal("keeper-socket-identity-changed", "The keeper's bound socket identity changed."),
    );
  }
  if (input.holders.length !== 1 || input.holders[0] !== input.keeperIdentity.pid) {
    refusals.push(
      refusal("keeper-not-sole-holder", "The keeper is not the sole bound socket holder."),
    );
  }
  if (
    input.currentPidfile === undefined ||
    !observerProcessIdentitiesMatch(input.currentPidfile, input.keeperIdentity)
  ) {
    refusals.push(
      refusal("keeper-pidfile-mismatch", "The keeper's strict process identity file changed."),
    );
  }
  if (
    keeperProcess === undefined ||
    keeperProcess.socketPath !== input.socketPath ||
    keeperProcess.startToken !== input.keeperIdentity.osStartTime ||
    input.keeperStartToken !== input.keeperIdentity.osStartTime
  ) {
    refusals.push(
      refusal("keeper-process-mismatch", "The keeper's PID, start token, or socket disagrees."),
    );
  }
  return refusals;
}

function selectAutomaticCandidate(
  input: ObserverDuplicateCleanupPlanInput,
  candidate: ObserverProcessEntry,
): { target: ObserverDuplicateCleanupTarget } | { refusal: ObserverDuplicateCleanupRefusal } {
  if (candidate.startToken.length === 0) {
    return {
      refusal: refusal(
        "candidate-start-token-unavailable",
        "The candidate has no immutable OS start token.",
        candidate.pid,
      ),
    };
  }
  const fdCount = input.candidateUnixSocketFdCounts.get(candidate.pid);
  if (fdCount === undefined) {
    return {
      refusal: refusal(
        "candidate-socket-fd-evidence-unavailable",
        "The candidate's Unix-domain socket descriptor evidence is unavailable.",
        candidate.pid,
      ),
    };
  }
  if (fdCount !== 0) {
    return {
      refusal: refusal(
        "candidate-holds-unix-socket",
        `The candidate owns ${fdCount} Unix-domain socket descriptor(s).`,
        candidate.pid,
      ),
    };
  }
  const target: ObserverDuplicateCleanupTarget = {
    pid: candidate.pid,
    startToken: candidate.startToken,
    quarantineMs: Math.max(
      input.legacyQuarantineMs,
      candidate.startupTimeoutMs ?? input.legacyQuarantineMs,
    ),
  };
  if (candidate.startupTimeoutMs !== undefined) {
    target.startupTimeoutMs = candidate.startupTimeoutMs;
  }
  return { target };
}

/**
 * USE CASE
 *
 * Performs one single-flight duplicate inspection, quarantine, claim-held final
 * revalidation, and optional SIGTERM-only cleanup with shutdown cancellation.
 */
export function createObserverDuplicateCleanup(
  options: ObserverDuplicateCleanupOptions,
  deps: ObserverDuplicateCleanupDeps,
): ObserverDuplicateCleanup {
  const controller = new AbortController();
  const sleep = deps.sleep ?? abortableSleep;
  let current = outcome(options.socketPath, "pending");
  let flight: Promise<ObserverDuplicateCleanupOutcome> | undefined;

  const run = (): Promise<ObserverDuplicateCleanupOutcome> => {
    flight ??= runObserverDuplicateCleanup({
      options,
      deps,
      sleep,
      signal: controller.signal,
      publish: (status) => {
        current = status;
      },
    });
    return flight;
  };

  return {
    run,
    abort: () => controller.abort(),
    status: () => current,
  };
}

type AutomaticCleanupContext = {
  options: ObserverDuplicateCleanupOptions;
  deps: ObserverDuplicateCleanupDeps;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  publish: (outcome: ObserverDuplicateCleanupOutcome) => void;
};

async function runObserverDuplicateCleanup(
  context: AutomaticCleanupContext,
): Promise<ObserverDuplicateCleanupOutcome> {
  const { options, deps, sleep, signal, publish } = context;
  const finish = (next: ObserverDuplicateCleanupOutcome): ObserverDuplicateCleanupOutcome => {
    publish(next);
    return next;
  };
  publish(outcome(options.socketPath, "running"));

  const initial = await inspectAutomaticCandidates(options, deps.evidence);
  if (initial instanceof Error) {
    return finish(refusedOutcome(options.socketPath, "evidence-unavailable", initial.message));
  }
  if (initial.plan.duplicates === 0) {
    return finish(outcome(options.socketPath, "clear"));
  }
  if (initial.plan.eligibleTargets.length === 0) {
    return finish(outcomeFromPlan(options.socketPath, "refused", initial.plan));
  }

  const quarantineMs = Math.max(
    ...initial.plan.eligibleTargets.map((target) => target.quarantineMs),
  );
  if (signal.aborted) {
    return finish(outcome(options.socketPath, "cancelled"));
  }
  await sleep(quarantineMs, signal);
  if (signal.aborted) {
    return finish(outcome(options.socketPath, "cancelled"));
  }

  const excluded = await deps.exclusion.runExclusive(() =>
    runClaimHeldDuplicateCleanup(context, initial),
  );

  if (excluded.status === "busy") {
    return finish(
      refusedOutcome(
        options.socketPath,
        "boot-claim-busy",
        "Observer startup owns the boot claim; duplicate cleanup refused without waiting.",
      ),
    );
  }
  if (excluded.status === "failed") {
    return finish(refusedOutcome(options.socketPath, "boot-claim-failed", excluded.reason));
  }
  return finish({ ...excluded.value, claimReleased: excluded.released });
}

async function runClaimHeldDuplicateCleanup(
  context: AutomaticCleanupContext,
  initial: AutomaticInspection,
): Promise<ObserverDuplicateCleanupOutcome> {
  const { options, deps } = context;
  const finalInspection = await inspectAutomaticCandidates(options, deps.evidence);
  if (finalInspection instanceof Error) {
    return refusedOutcome(options.socketPath, "evidence-unavailable", finalInspection.message);
  }
  const unchangedTargets = unchangedEligibleTargets(initial, finalInspection);
  if (unchangedTargets.length === 0) {
    const changed = refusal(
      "candidate-changed-during-quarantine",
      "No candidate retained exact process evidence through quarantine.",
    );
    return outcomeFromPlan(options.socketPath, "refused", {
      ...finalInspection.plan,
      refusals: [...finalInspection.plan.refusals, changed],
    });
  }
  if (options.mode === "terminate") {
    return terminateAutomaticTargets(context, finalInspection, unchangedTargets);
  }
  const keeperPreservation = await inspectKeeperPreservation(options, deps.evidence);
  return {
    ...outcomeFromPlan(options.socketPath, "would-terminate", finalInspection.plan),
    eligiblePids: unchangedTargets.map((target) => target.pid),
    keeperPreservation,
  };
}

async function terminateAutomaticTargets(
  context: AutomaticCleanupContext,
  finalInspection: AutomaticInspection,
  targets: ObserverDuplicateCleanupTarget[],
): Promise<ObserverDuplicateCleanupOutcome> {
  const { options, deps, sleep, signal } = context;
  const sentTargets: ObserverDuplicateCleanupTarget[] = [];
  const signalRefusals: ObserverDuplicateCleanupRefusal[] = [];
  const terminatedPids: number[] = [];
  for (const target of targets) {
    if (signal.aborted) return outcome(options.socketPath, "cancelled");
    const immediate = await inspectAutomaticCandidates(options, deps.evidence);
    if (immediate instanceof Error || !targetRemainsEligible(target, immediate)) {
      signalRefusals.push(
        refusal(
          "candidate-changed-before-signal",
          "The candidate changed immediately before signaling.",
          target.pid,
        ),
      );
      continue;
    }
    recordSigtermResult(target, deps.evidence.signal(target.pid, "SIGTERM"), {
      sentTargets,
      signalRefusals,
      terminatedPids,
    });
  }

  if (sentTargets.length > 0) {
    await sleep(options.exitGraceMs ?? DEFAULT_SIGTERM_GRACE_MS, signal);
  }
  if (signal.aborted) return outcome(options.socketPath, "cancelled");

  const survivedPids = classifyTerminatedTargets(
    sentTargets,
    terminatedPids,
    options.socketPath,
    deps.evidence,
  );
  const keeperPreservation = await inspectKeeperPreservation(options, deps.evidence);
  const allRefusals = [...finalInspection.plan.refusals, ...signalRefusals];
  const status =
    survivedPids.length > 0 || allRefusals.length > 0 || !keeperPreservation.preserved
      ? "survived"
      : "terminated";
  return {
    ...outcomeFromPlan(options.socketPath, status, {
      ...finalInspection.plan,
      refusals: allRefusals,
    }),
    eligiblePids: targets.map((target) => target.pid),
    terminatedPids,
    survivedPids,
    keeperPreservation,
  };
}

function recordSigtermResult(
  target: ObserverDuplicateCleanupTarget,
  result: ReturnType<ObserverDuplicateProcessEvidenceSource["signal"]>,
  output: {
    sentTargets: ObserverDuplicateCleanupTarget[];
    signalRefusals: ObserverDuplicateCleanupRefusal[];
    terminatedPids: number[];
  },
): void {
  if (result === "sent") {
    output.sentTargets.push(target);
  } else if (result === "absent") {
    output.terminatedPids.push(target.pid);
  } else {
    output.signalRefusals.push(
      refusal("sigterm-refused", "The operating system refused SIGTERM.", target.pid),
    );
  }
}

function classifyTerminatedTargets(
  sentTargets: ObserverDuplicateCleanupTarget[],
  terminatedPids: number[],
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): number[] {
  const survivedPids: number[] = [];
  for (const target of sentTargets) {
    if (exactProcessRemains(target, socketPath, evidence)) survivedPids.push(target.pid);
    else terminatedPids.push(target.pid);
  }
  return survivedPids;
}

async function inspectAutomaticCandidates(
  options: Pick<
    ObserverDuplicateCleanupOptions,
    "socketPath" | "keeperIdentity" | "boundSocketIdentity" | "legacyQuarantineMs"
  >,
  evidence: ObserverDuplicateProcessEvidenceSource,
): Promise<AutomaticInspection | Error> {
  try {
    const processes = evidence.listObserverProcesses();
    const candidateUnixSocketFdCounts = new Map<number, number>();
    for (const candidate of processes) {
      if (
        candidate.pid === options.keeperIdentity.pid ||
        candidate.socketPath !== options.socketPath
      ) {
        continue;
      }
      try {
        candidateUnixSocketFdCounts.set(candidate.pid, evidence.unixSocketFdCount(candidate.pid));
      } catch {
        // A missing map entry is the policy's explicit unavailable-evidence refusal.
      }
    }
    const [currentPidfile, currentSocketIdentity] = await Promise.all([
      evidence.readProcessIdentity(options.socketPath),
      evidence.socketIdentity(options.socketPath),
    ]);
    const planInput: ObserverDuplicateCleanupPlanInput = {
      socketPath: options.socketPath,
      keeperIdentity: options.keeperIdentity,
      boundSocketIdentity: options.boundSocketIdentity,
      holders: evidence.socketHolders(options.socketPath),
      processes,
      candidateUnixSocketFdCounts,
      legacyQuarantineMs: options.legacyQuarantineMs ?? DEFAULT_LEGACY_QUARANTINE_MS,
    };
    if (currentSocketIdentity !== undefined) {
      planInput.currentSocketIdentity = currentSocketIdentity;
    }
    const keeperStartToken = evidence.processStartToken(options.keeperIdentity.pid);
    if (keeperStartToken !== undefined) planInput.keeperStartToken = keeperStartToken;
    if (currentPidfile !== undefined) planInput.currentPidfile = currentPidfile;
    const plan = selectObserverDuplicateCleanupPlan(planInput);
    return { plan, processes };
  } catch {
    return new Error("Strict duplicate-process evidence could not be collected.");
  }
}

function unchangedEligibleTargets(
  initial: AutomaticInspection,
  finalInspection: AutomaticInspection,
): ObserverDuplicateCleanupTarget[] {
  return initial.plan.eligibleTargets.filter((target) => {
    if (!targetRemainsEligible(target, finalInspection)) return false;
    const initialEntry = initial.processes.find((entry) => entry.pid === target.pid);
    const finalEntry = finalInspection.processes.find((entry) => entry.pid === target.pid);
    return (
      initialEntry !== undefined &&
      finalEntry !== undefined &&
      processEntriesMatch(initialEntry, finalEntry)
    );
  });
}

function targetRemainsEligible(
  target: ObserverDuplicateCleanupTarget,
  inspection: AutomaticInspection,
): boolean {
  return inspection.plan.eligibleTargets.some(
    (candidate) =>
      candidate.pid === target.pid &&
      candidate.startToken === target.startToken &&
      candidate.startupTimeoutMs === target.startupTimeoutMs,
  );
}

function processEntriesMatch(left: ObserverProcessEntry, right: ObserverProcessEntry): boolean {
  return (
    left.pid === right.pid &&
    left.startToken === right.startToken &&
    left.socketPath === right.socketPath &&
    left.startupTimeoutMs === right.startupTimeoutMs &&
    left.argv.length === right.argv.length &&
    left.argv.every((value, index) => value === right.argv[index])
  );
}

function exactProcessRemains(
  target: Pick<ObserverDuplicateCleanupTarget, "pid" | "startToken">,
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): boolean {
  if (
    evidence.signal(target.pid, 0) === "absent" ||
    evidence.processStartToken(target.pid) !== target.startToken
  ) {
    return false;
  }
  return evidence
    .listObserverProcesses()
    .some(
      (entry) =>
        entry.pid === target.pid &&
        entry.startToken === target.startToken &&
        entry.socketPath === socketPath,
    );
}

async function inspectKeeperPreservation(
  options: Pick<
    ObserverDuplicateCleanupOptions,
    "socketPath" | "keeperIdentity" | "boundSocketIdentity"
  >,
  evidence: ObserverDuplicateProcessEvidenceSource,
): Promise<ObserverKeeperPreservation> {
  try {
    const [currentPidfile, currentSocketIdentity] = await Promise.all([
      evidence.readProcessIdentity(options.socketPath),
      evidence.socketIdentity(options.socketPath),
    ]);
    const pid =
      evidence.processStartToken(options.keeperIdentity.pid) === options.keeperIdentity.osStartTime;
    const socketIdentity = socketIdentitiesMatch(
      currentSocketIdentity,
      options.boundSocketIdentity,
    );
    const pidfile =
      currentPidfile !== undefined &&
      observerProcessIdentitiesMatch(currentPidfile, options.keeperIdentity);
    return { pid, socketIdentity, pidfile, preserved: pid && socketIdentity && pidfile };
  } catch {
    return { pid: false, socketIdentity: false, pidfile: false, preserved: false };
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
  survived: number[];
  keeperPreservation?: ObserverKeeperPreservation;
};

export type RunObserverReapDeps = {
  evidence: ObserverDuplicateProcessEvidenceSource;
  healthPid?: (socketPath: string) => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
};

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
 * Runs the explicit operator reap with centralized selection and revalidation;
 * only this manual force path may escalate from SIGTERM to SIGKILL.
 */
export async function runObserverReap(
  socketPath: string,
  options: { force: boolean; graceMs?: number } = { force: false },
  deps: RunObserverReapDeps,
): Promise<ObserverReapOutcome> {
  const { plan, holders } = await buildObserverReapPlan(socketPath, deps);
  if (!options.force || plan.keeper === undefined || plan.targets.length === 0) {
    return { plan, applied: false, killed: [], survived: [] };
  }
  return applyObserverReap({
    socketPath,
    options,
    plan,
    keeper: plan.keeper,
    holders,
    deps,
  });
}

async function buildObserverReapPlan(
  socketPath: string,
  deps: RunObserverReapDeps,
): Promise<{ plan: ObserverReapPlan; holders: number[] }> {
  const processes = deps.evidence.listObserverProcesses();
  const holders = deps.evidence.socketHolders(socketPath);
  const healthPid =
    holders.length > 1 && deps.healthPid !== undefined
      ? await deps.healthPid(socketPath)
      : undefined;
  const selectionInput: {
    socketPath: string;
    processes: ObserverProcessEntry[];
    holders: number[];
    healthPid?: number;
  } = { socketPath, processes, holders };
  if (healthPid !== undefined) selectionInput.healthPid = healthPid;
  const selected = selectObserverReapPlan(selectionInput);
  const plan = await addAutomaticEligibility(selected, deps.evidence);
  return { plan, holders };
}

type ApplyObserverReapInput = {
  socketPath: string;
  options: { force: boolean; graceMs?: number };
  plan: ObserverReapPlan;
  keeper: number;
  holders: number[];
  deps: RunObserverReapDeps;
};

async function applyObserverReap(input: ApplyObserverReapInput): Promise<ObserverReapOutcome> {
  const { socketPath, options, plan, keeper, holders, deps } = input;
  const sleep = deps.sleep ?? defaultSleep;
  const baseline = await captureManualKeeperBaseline(socketPath, keeper, deps.evidence);
  const ownerBaseline = sortedPidKey(holders);
  const ownerChanged = (): boolean =>
    sortedPidKey(deps.evidence.socketHolders(socketPath)) !== ownerBaseline;
  const aborted = (): ObserverReapOutcome => ({
    plan,
    applied: true,
    aborted: "owner-changed",
    killed: [],
    survived: [],
  });

  for (const target of plan.targets) {
    if (ownerChanged()) return aborted();
    if (manualTargetRemains(target, socketPath, deps.evidence)) {
      deps.evidence.signal(target.pid, "SIGTERM");
    }
  }
  await sleep(options.graceMs ?? DEFAULT_SIGTERM_GRACE_MS);
  for (const target of plan.targets) {
    if (!exactProcessRemains(target, socketPath, deps.evidence)) continue;
    if (ownerChanged()) return aborted();
    if (manualTargetRemains(target, socketPath, deps.evidence)) {
      deps.evidence.signal(target.pid, "SIGKILL");
    }
  }
  await sleep(SIGKILL_CONFIRM_MS);

  const { killed, survived } = classifyManualReapTargets(plan.targets, socketPath, deps.evidence);
  const keeperPreservation = await inspectManualKeeperPreservation(
    socketPath,
    keeper,
    baseline,
    deps.evidence,
  );
  return { plan, applied: true, killed, survived, keeperPreservation };
}

function manualTargetRemains(
  target: ObserverReapTarget,
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): boolean {
  return (
    !evidence.socketHolders(socketPath).includes(target.pid) &&
    evidence.processStartToken(target.pid) === target.startToken &&
    evidence
      .listObserverProcesses()
      .some(
        (entry) =>
          entry.pid === target.pid &&
          entry.startToken === target.startToken &&
          entry.socketPath === socketPath,
      )
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
    if (exactProcessRemains(target, socketPath, evidence)) survived.push(target.pid);
    else killed.push(target.pid);
  }
  return { killed, survived };
}

function sortedPidKey(pids: number[]): string {
  return [...pids].sort((left, right) => left - right).join(",");
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

  const processes = evidence.listObserverProcesses();
  const candidateUnixSocketFdCounts = new Map<number, number>();
  for (const target of plan.targets) {
    try {
      candidateUnixSocketFdCounts.set(target.pid, evidence.unixSocketFdCount(target.pid));
    } catch {
      // The policy reports unavailable evidence from the absent map entry.
    }
  }
  const automaticInput: ObserverDuplicateCleanupPlanInput = {
    socketPath: plan.socketPath,
    keeperIdentity: pidfile,
    boundSocketIdentity: socketIdentity,
    currentSocketIdentity: socketIdentity,
    holders: evidence.socketHolders(plan.socketPath),
    currentPidfile: pidfile,
    processes,
    candidateUnixSocketFdCounts,
    legacyQuarantineMs: DEFAULT_LEGACY_QUARANTINE_MS,
  };
  const keeperStartToken = evidence.processStartToken(plan.keeper);
  if (keeperStartToken !== undefined) automaticInput.keeperStartToken = keeperStartToken;
  const automaticPlan = selectObserverDuplicateCleanupPlan(automaticInput);
  return {
    ...plan,
    targets: plan.targets.map((target) => {
      const eligible = automaticPlan.eligibleTargets.find(
        (candidate) => candidate.pid === target.pid,
      );
      const reasons = automaticRefusalReasons(automaticPlan.refusals, target.pid);
      return {
        ...target,
        automaticEligibility: {
          eligible: eligible !== undefined,
          quarantineMs: eligible?.quarantineMs ?? target.automaticEligibility.quarantineMs,
          refusalReasons: reasons,
        },
      };
    }),
  };
}

function automaticRefusalReasons(
  refusals: ObserverDuplicateCleanupRefusal[],
  pid: number,
): string[] {
  const reasons: string[] = [];
  for (const entry of refusals) {
    if (entry.pid === undefined || entry.pid === pid) reasons.push(entry.reason);
  }
  return reasons;
}

type ManualKeeperBaseline = {
  startToken?: string;
  socketIdentity?: SocketIdentity;
  pidfile?: ObserverProcessIdentity;
};

async function captureManualKeeperBaseline(
  socketPath: string,
  keeper: number,
  evidence: ObserverDuplicateProcessEvidenceSource,
): Promise<ManualKeeperBaseline> {
  const [pidfile, socketIdentity] = await Promise.all([
    evidence.readProcessIdentity(socketPath),
    evidence.socketIdentity(socketPath),
  ]);
  const baseline: ManualKeeperBaseline = {};
  const startToken = evidence.processStartToken(keeper);
  if (startToken !== undefined) baseline.startToken = startToken;
  if (socketIdentity !== undefined) baseline.socketIdentity = socketIdentity;
  if (pidfile !== undefined) baseline.pidfile = pidfile;
  return baseline;
}

async function inspectManualKeeperPreservation(
  socketPath: string,
  keeper: number,
  baseline: ManualKeeperBaseline,
  evidence: ObserverDuplicateProcessEvidenceSource,
): Promise<ObserverKeeperPreservation> {
  const [pidfile, socketIdentity] = await Promise.all([
    evidence.readProcessIdentity(socketPath),
    evidence.socketIdentity(socketPath),
  ]);
  const pid =
    baseline.startToken !== undefined && evidence.processStartToken(keeper) === baseline.startToken;
  const preservedSocket =
    baseline.socketIdentity !== undefined &&
    socketIdentitiesMatch(socketIdentity, baseline.socketIdentity);
  const preservedPidfile =
    baseline.pidfile !== undefined &&
    pidfile !== undefined &&
    observerProcessIdentitiesMatch(pidfile, baseline.pidfile);
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

function refusal(code: string, reason: string, pid?: number): ObserverDuplicateCleanupRefusal {
  const result: ObserverDuplicateCleanupRefusal = { code, reason };
  if (pid !== undefined) result.pid = pid;
  return result;
}

function outcome(
  socketPath: string,
  status: ObserverDuplicateCleanupOutcome["status"],
): ObserverDuplicateCleanupOutcome {
  return {
    socketPath,
    status,
    eligiblePids: [],
    refusalCodes: [],
    refusals: [],
    terminatedPids: [],
    survivedPids: [],
  };
}

function outcomeFromPlan(
  socketPath: string,
  status: ObserverDuplicateCleanupOutcome["status"],
  plan: ObserverDuplicateCleanupPlan,
): ObserverDuplicateCleanupOutcome {
  return {
    ...outcome(socketPath, status),
    eligiblePids: plan.eligibleTargets.map((target) => target.pid),
    refusalCodes: plan.refusals.map((entry) => entry.code),
    refusals: plan.refusals,
  };
}

function refusedOutcome(
  socketPath: string,
  code: string,
  reason: string,
): ObserverDuplicateCleanupOutcome {
  const entry = refusal(code, reason);
  return {
    ...outcome(socketPath, "refused"),
    refusalCodes: [code],
    refusals: [entry],
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
