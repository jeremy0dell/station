import type { ObserverProcessIdentity } from "@station/contracts";
import {
  type ObserverProcessEntry,
  type ObserverProcessEvidenceSource,
  observerProcessEntriesMatch,
} from "./observerHandoff.js";
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
  process: ObserverProcessEntry;
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
  unixSocketFdCount(process: ObserverProcessEntry): number;
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
  exitedPids: number[];
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
 * Selects duplicate Observers only when the keeper's corroborated identity is
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
    keeperProcess.processToken !== input.keeperIdentity.processToken ||
    keeperProcess.buildVersion !== input.keeperIdentity.version ||
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
        "The candidate has no corroborating OS start token.",
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
    process: candidate,
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
  if (signal.aborted) {
    return finish(outcome(options.socketPath, "cancelled"));
  }
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
  const { options, deps, signal } = context;
  if (signal.aborted) return outcome(options.socketPath, "cancelled");
  const finalInspection = await inspectAutomaticCandidates(options, deps.evidence);
  if (signal.aborted) return outcome(options.socketPath, "cancelled");
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
  if (signal.aborted) return outcome(options.socketPath, "cancelled");
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
  const exitedPids: number[] = [];
  for (const target of targets) {
    if (signal.aborted) return outcome(options.socketPath, "cancelled");
    const immediate = await inspectAutomaticCandidates(options, deps.evidence);
    if (signal.aborted) return outcome(options.socketPath, "cancelled");
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
      exitedPids,
    });
  }

  if (sentTargets.length > 0) {
    await sleep(options.exitGraceMs ?? DEFAULT_SIGTERM_GRACE_MS, signal);
  }
  if (signal.aborted) return outcome(options.socketPath, "cancelled");

  const classified = classifyAutomaticTargets(sentTargets, options.socketPath, deps.evidence);
  terminatedPids.push(...classified.terminatedPids);
  const survivedPids = classified.survivedPids;
  const keeperPreservation = await inspectKeeperPreservation(options, deps.evidence);
  if (signal.aborted) return outcome(options.socketPath, "cancelled");
  const allRefusals = [...finalInspection.plan.refusals, ...signalRefusals, ...classified.refusals];
  const status =
    survivedPids.length > 0
      ? "survived"
      : allRefusals.length > 0 || !keeperPreservation.preserved
        ? "refused"
        : "terminated";
  return {
    ...outcomeFromPlan(options.socketPath, status, {
      ...finalInspection.plan,
      refusals: allRefusals,
    }),
    eligiblePids: targets.map((target) => target.pid),
    terminatedPids,
    exitedPids,
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
    exitedPids: number[];
  },
): void {
  if (result === "sent") {
    output.sentTargets.push(target);
  } else if (result === "absent") {
    output.exitedPids.push(target.pid);
    output.signalRefusals.push(
      refusal(
        "candidate-exited-before-signal",
        "The candidate exited before SIGTERM could be sent.",
        target.pid,
      ),
    );
  } else {
    output.signalRefusals.push(
      refusal("sigterm-refused", "The operating system refused SIGTERM.", target.pid),
    );
  }
}

function classifyAutomaticTargets(
  sentTargets: ObserverDuplicateCleanupTarget[],
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): {
  terminatedPids: number[];
  survivedPids: number[];
  refusals: ObserverDuplicateCleanupRefusal[];
} {
  const terminatedPids: number[] = [];
  const survivedPids: number[] = [];
  const refusals: ObserverDuplicateCleanupRefusal[] = [];
  for (const target of sentTargets) {
    const state = inspectExactProcess(target, socketPath, evidence);
    if (state === "absent") terminatedPids.push(target.pid);
    else if (state === "same") survivedPids.push(target.pid);
    else {
      refusals.push(
        refusal(
          state === "changed" ? "candidate-changed-after-signal" : "evidence-unavailable",
          state === "changed"
            ? "The target PID named a different process after SIGTERM."
            : "The target could not be classified after SIGTERM.",
          target.pid,
        ),
      );
    }
  }
  return { terminatedPids, survivedPids, refusals };
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
        candidateUnixSocketFdCounts.set(candidate.pid, evidence.unixSocketFdCount(candidate));
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
      observerProcessEntriesMatch(initialEntry, finalEntry)
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
      candidate.startupTimeoutMs === target.startupTimeoutMs &&
      observerProcessEntriesMatch(candidate.process, target.process),
  );
}

function inspectExactProcess(
  target: Pick<ObserverDuplicateCleanupTarget, "pid" | "startToken" | "process">,
  socketPath: string,
  evidence: ObserverDuplicateProcessEvidenceSource,
): "same" | "absent" | "changed" | "unavailable" {
  try {
    const exists = evidence.signal(target.pid, 0);
    if (exists === "absent") return "absent";
    if (exists === "refused") return "unavailable";
    const startToken = evidence.processStartToken(target.pid);
    if (startToken === undefined) return "unavailable";
    if (startToken !== target.startToken) return "changed";
    const process = evidence.listObserverProcesses().find((entry) => entry.pid === target.pid);
    if (process === undefined) return "unavailable";
    return observerProcessEntriesMatch(process, target.process) && process.socketPath === socketPath
      ? "same"
      : "changed";
  } catch {
    return "unavailable";
  }
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
    const holders = evidence.socketHolders(options.socketPath);
    const pid =
      holders.length === 1 &&
      holders[0] === options.keeperIdentity.pid &&
      evidence.processStartToken(options.keeperIdentity.pid) ===
        options.keeperIdentity.osStartTime &&
      evidence
        .listObserverProcesses()
        .some(
          (entry) =>
            entry.pid === options.keeperIdentity.pid &&
            entry.startToken === options.keeperIdentity.osStartTime &&
            entry.processToken === options.keeperIdentity.processToken &&
            entry.buildVersion === options.keeperIdentity.version &&
            entry.socketPath === options.socketPath,
        );
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
  exclusion: ObserverDuplicateCleanupExclusion;
  healthPid: (socketPath: string) => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
};

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
  const { plan } = await buildObserverReapPlan(socketPath, deps);
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

async function buildObserverReapPlan(
  socketPath: string,
  deps: RunObserverReapDeps,
): Promise<{ plan: ObserverReapPlan; holders: number[] }> {
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
  const selected = selectObserverReapPlan(selectionInput);
  const plan = await addAutomaticEligibility(selected, deps.evidence);
  return { plan, holders };
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
    evidence.processStartToken(target.pid) === target.startToken &&
    evidence.unixSocketFdCount(target.process) === 0 &&
    evidence
      .listObserverProcesses()
      .some(
        (entry) =>
          observerProcessEntriesMatch(entry, target.process) && entry.socketPath === socketPath,
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

  const processes = evidence.listObserverProcesses();
  const candidateUnixSocketFdCounts = new Map<number, number>();
  for (const target of plan.targets) {
    try {
      candidateUnixSocketFdCounts.set(target.pid, evidence.unixSocketFdCount(target.process));
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
  const startToken = evidence.processStartToken(keeper);
  const holders = evidence.socketHolders(socketPath);
  const process = evidence.listObserverProcesses().find((entry) => entry.pid === keeper);
  if (
    pidfile === undefined ||
    socketIdentity === undefined ||
    startToken === undefined ||
    process === undefined ||
    healthyPid !== keeper ||
    holders.length !== 1 ||
    holders[0] !== keeper ||
    pidfile.pid !== keeper ||
    pidfile.socketPath !== socketPath ||
    pidfile.osStartTime !== startToken ||
    process.startToken !== startToken ||
    process.processToken !== pidfile.processToken ||
    process.buildVersion !== pidfile.version ||
    process.socketPath !== socketPath
  ) {
    return undefined;
  }
  return { keeper, startToken, socketIdentity, pidfile, process };
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
  const process = evidence.listObserverProcesses().find((entry) => entry.pid === baseline.keeper);
  return (
    holders.length === 1 &&
    holders[0] === baseline.keeper &&
    healthyPid === baseline.keeper &&
    evidence.processStartToken(baseline.keeper) === baseline.startToken &&
    process !== undefined &&
    observerProcessEntriesMatch(process, baseline.process) &&
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
  const process = evidence.listObserverProcesses().find((entry) => entry.pid === baseline.keeper);
  const pid =
    holders.length === 1 &&
    holders[0] === baseline.keeper &&
    healthyPid === baseline.keeper &&
    evidence.processStartToken(baseline.keeper) === baseline.startToken &&
    process !== undefined &&
    observerProcessEntriesMatch(process, baseline.process);
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
    exitedPids: [],
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
