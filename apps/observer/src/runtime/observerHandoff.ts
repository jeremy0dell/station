import type {
  ObserverHealth,
  ObserverProcessIdentity,
  ObserverStopReceipt,
  SafeError,
} from "@station/contracts";
import { TimestampSchema } from "@station/contracts";
import {
  Effect,
  hasStationObserverBuildIdentityMarker,
  isSafeError,
  parseStationObserverBuildVersion,
} from "@station/runtime";
import { z } from "zod";
import {
  type ObserverProcessIdentityEvidenceSource,
  observerProcessIdentitiesMatch,
  verifyObserverProcessIdentity,
} from "./observerProcessIdentity.js";

const GRACEFUL_HANDOFF_BUDGET_RATIO = 0.5;
const MAX_STOP_ACKNOWLEDGEMENT_MS = 1_000;
const DEFAULT_HANDOFF_POLL_INTERVAL_MS = 50;
const MIN_HANDOFF_TIMEOUT_MS = 1;
const INTERNAL_PREVIEW_VERSION_PATTERN = /^0\.7\.1-rc\.(?:0|[1-9]\d*)$/u;
const PUBLIC_PRE_ALPHA_VERSION_PATTERN =
  /^0\.0\.0-pre-alpha\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;

const SemVerSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
    "Expected a strict SemVer version.",
  )
  .transform((version) => {
    const precedence = version.split("+", 1)[0] ?? version;
    const prereleaseSeparator = precedence.indexOf("-");
    const release =
      prereleaseSeparator === -1 ? precedence : precedence.slice(0, prereleaseSeparator);
    const prerelease =
      prereleaseSeparator === -1 ? undefined : precedence.slice(prereleaseSeparator + 1);
    const [major = "0", minor = "0", patch = "0"] = release.split(".");
    return {
      version,
      release: [major, minor, patch] as const,
      prerelease: prerelease?.split("."),
    };
  });

const HandoffCandidateSchema = z
  .object({
    version: z.string(),
    startedAt: TimestampSchema,
    pid: z.number().int().positive(),
  })
  .strict();

/** Returns whether an Observer argv selector is valid unadorned SemVer or an exact Station build. */
export function observerBuildSelectorIsValid(selector: string): boolean {
  const build = parseStationObserverBuildVersion(selector);
  return (
    !(build.buildIdentity === undefined && hasStationObserverBuildIdentityMarker(selector)) &&
    SemVerSchema.safeParse(build.version).success
  );
}

export type ObserverHandoffCandidate = z.infer<typeof HandoffCandidateSchema>;

/** Selector ordering only; it never authorizes process replacement or lifecycle mutation. */
export type ObserverBuildPrecedenceResult =
  | { outcome: "exact-build" }
  | { outcome: "candidate-precedes" }
  | { outcome: "incumbent-precedes" }
  | { outcome: "refused"; reason: string };

export type ObserverIncumbentDecision =
  | { action: "attach"; reason: "exact-build" | "incumbent-wins" }
  | { action: "replace"; reason: "candidate-wins" }
  | { action: "refuse"; reason: string };

export type ObserverProcessSignalResult = "sent" | "absent" | "refused";

export type ObserverLifecycleRequest = {
  timeoutMs: number;
};

export type ObserverExpectedProcessHealth = {
  pid: number;
  startedAt: string;
  version: string;
  socketPath: string;
};

export type ObserverStopRequest = ObserverLifecycleRequest & {
  /** Process identity that must answer health on the same connection used for stop. */
  expectedObserver: ObserverExpectedProcessHealth;
};

/**
 * DRIVEN PORT
 *
 * Supplies exact incumbent-process evidence without exposing operating-system
 * commands; typed evidence failures remain available as causes, while unavailable
 * socket-holder evidence throws and never means zero.
 */
export interface ObserverProcessEvidenceSource extends ObserverProcessIdentityEvidenceSource {
  socketHolders(socketPath: string): number[];
  readProcessIdentity(socketPath: string): Promise<ObserverProcessIdentity | undefined>;
  signal(pid: number, signal: NodeJS.Signals | 0): ObserverProcessSignalResult;
}

/**
 * DRIVEN PORT
 *
 * Exposes validated incumbent lifecycle operations while keeping transport
 * mechanics outside handoff; inaccessible sockets cannot count as process exit.
 */
export interface ObserverIncumbentLifecycle {
  health(socketPath: string, request: ObserverLifecycleRequest): Promise<ObserverHealth>;
  stop(socketPath: string, request: ObserverStopRequest): Promise<ObserverStopReceipt>;
  socketListening(socketPath: string, request: ObserverLifecycleRequest): Promise<boolean>;
}

export type ObserverHandoffResult =
  | { action: "attach"; health: ObserverHealth }
  | { action: "replaced"; health: ObserverHealth };

export type ObserverHandoffError = Error & SafeError;

type ObserverHandoffDeps = {
  lifecycle: ObserverIncumbentLifecycle;
  evidence: ObserverProcessEvidenceSource;
  /** Completes candidate-owned prerequisites before the verified incumbent may be stopped. */
  prepareReplacement?: (request: ObserverLifecycleRequest) => Promise<void>;
  /** Atomically enters irreversible replacement after refusing any pending candidate cancellation. */
  commitReplacement?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
};

/**
 * POLICY
 *
 * Orders Observer build selectors without process or lifecycle authority,
 * preserving singleton SemVer, immutable-build, and public-version-line rules.
 */
export function classifyObserverBuildPrecedence(input: {
  candidateSelector: string;
  incumbentSelector: string | undefined;
}): ObserverBuildPrecedenceResult {
  const candidateBuild = parseStationObserverBuildVersion(input.candidateSelector);
  if (
    candidateBuild.buildIdentity === undefined &&
    hasStationObserverBuildIdentityMarker(input.candidateSelector)
  ) {
    return { outcome: "refused", reason: "The candidate Observer build identity is invalid." };
  }
  const candidateVersion = SemVerSchema.safeParse(candidateBuild.version);
  if (!candidateVersion.success) {
    return { outcome: "refused", reason: "The candidate Observer version is not valid SemVer." };
  }
  if (input.incumbentSelector === undefined) {
    return { outcome: "refused", reason: "The incumbent Observer did not report a version." };
  }
  const incumbentBuild = parseStationObserverBuildVersion(input.incumbentSelector);
  if (
    incumbentBuild.buildIdentity === undefined &&
    hasStationObserverBuildIdentityMarker(input.incumbentSelector)
  ) {
    return { outcome: "refused", reason: "The incumbent Observer build identity is invalid." };
  }
  const incumbentVersion = SemVerSchema.safeParse(incumbentBuild.version);
  if (!incumbentVersion.success) {
    return { outcome: "refused", reason: "The incumbent Observer version is not valid SemVer." };
  }
  if (input.candidateSelector === input.incumbentSelector) {
    if (candidateBuild.buildIdentity === undefined) {
      return {
        outcome: "refused",
        reason: "Same-version Observer reuse requires immutable build identity.",
      };
    }
    return { outcome: "exact-build" };
  }
  if (candidateBuild.version === incumbentBuild.version) {
    if (candidateBuild.buildIdentity === undefined || incumbentBuild.buildIdentity === undefined) {
      return {
        outcome: "refused",
        reason: "Same-version Observer handoff requires build identity from both contenders.",
      };
    }
    const identityOrder = compareIdentifier(
      candidateBuild.buildIdentity,
      incumbentBuild.buildIdentity,
    );
    if (identityOrder <= 0) {
      return {
        outcome: "refused",
        reason: "A different build of this Station version already owns the Observer socket.",
      };
    }
  }
  const resetPrecedence = comparePublicVersionLineReset(
    candidateBuild.version,
    incumbentBuild.version,
  );
  const precedence = resetPrecedence ?? compareSemVer(candidateVersion.data, incumbentVersion.data);
  if (precedence < 0) return { outcome: "incumbent-precedes" };
  if (precedence === 0) {
    // Display-version strings are stable across the CLI parent and Observer child;
    // their process timestamps and PIDs are not the same contender identity.
    const buildOrder = compareIdentifier(
      candidateVersion.data.version,
      incumbentVersion.data.version,
    );
    if (buildOrder < 0) return { outcome: "incumbent-precedes" };
  }
  return { outcome: "candidate-precedes" };
}

/**
 * POLICY
 *
 * Maps shared build precedence to singleton attach, replace, or refusal,
 * requiring complete contender identity before admitting replacement.
 */
export function classifyObserverIncumbent(input: {
  candidate: ObserverHandoffCandidate;
  incumbent: Pick<ObserverHealth, "version" | "startedAt" | "pid">;
}): ObserverIncumbentDecision {
  const candidate = HandoffCandidateSchema.safeParse(input.candidate);
  if (!candidate.success) {
    return { action: "refuse", reason: "The candidate Observer identity is invalid." };
  }
  const precedence = classifyObserverBuildPrecedence({
    candidateSelector: candidate.data.version,
    incumbentSelector: input.incumbent.version,
  });
  if (precedence.outcome === "exact-build") {
    return { action: "attach", reason: "exact-build" };
  }
  if (precedence.outcome === "incumbent-precedes") {
    return { action: "attach", reason: "incumbent-wins" };
  }
  if (precedence.outcome === "refused") {
    return { action: "refuse", reason: precedence.reason };
  }
  const incumbentStartedAt = TimestampSchema.safeParse(input.incumbent.startedAt);
  if (!incumbentStartedAt.success || input.incumbent.pid === undefined) {
    return {
      action: "refuse",
      reason: "Replacing a different-build Observer requires complete incumbent identity.",
    };
  }
  return { action: "replace", reason: "candidate-wins" };
}

function comparePublicVersionLineReset(candidate: string, incumbent: string): -1 | 1 | undefined {
  if (
    PUBLIC_PRE_ALPHA_VERSION_PATTERN.test(candidate) &&
    INTERNAL_PREVIEW_VERSION_PATTERN.test(incumbent)
  ) {
    return 1;
  }
  if (
    INTERNAL_PREVIEW_VERSION_PATTERN.test(candidate) &&
    PUBLIC_PRE_ALPHA_VERSION_PATTERN.test(incumbent)
  ) {
    return -1;
  }
  return undefined;
}

/**
 * USE CASE
 *
 * Replaces an older incumbent only after corroborating its socket and process
 * identity, completing candidate prerequisites, revalidating the incumbent,
 * and synchronously refusing pending cancellation before committing to stop;
 * any pre-commit failure preserves the incumbent and remains available as the
 * typed handoff refusal's cause.
 */
export async function negotiateObserverIncumbent(
  input: {
    socketPath: string;
    candidate: ObserverHandoffCandidate;
    timeoutMs: number;
  },
  deps: ObserverHandoffDeps,
): Promise<ObserverHandoffResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + input.timeoutMs;
  const gracefulDeadline = deadline - Math.floor(input.timeoutMs * GRACEFUL_HANDOFF_BUDGET_RATIO);

  try {
    const health = await deps.lifecycle.health(input.socketPath, {
      timeoutMs: remainingHandoffMs(deadline, now),
    });
    const decision = classifyObserverIncumbent({ candidate: input.candidate, incumbent: health });
    if (decision.action === "attach") return { action: "attach", health };
    if (decision.action === "refuse") throw handoffRefused(decision.reason);

    const incumbent = (await requireVerifiedIncumbent(input, health, deps)).processIdentity;
    await deps.prepareReplacement?.({
      timeoutMs: remainingHandoffMs(deadline, now),
    });
    // The claim excludes another legitimate successor, but ownership evidence
    // is still refreshed after candidate preparation and immediately before
    // asking this exact process to stop.
    const revalidatedHealth = await deps.lifecycle.health(input.socketPath, {
      timeoutMs: remainingHandoffMs(deadline, now),
    });
    const revalidatedIncumbent = await requireVerifiedIncumbent(input, revalidatedHealth, deps);
    if (!observerProcessIdentitiesMatch(incumbent, revalidatedIncumbent.processIdentity)) {
      throw handoffRefused("The incumbent Observer process changed during handoff.");
    }
    // Cancellation may preserve the incumbent until this synchronous commit; after it, the
    // successor must retain startup authority long enough to own cleanup for the stopped process.
    deps.commitReplacement?.();
    try {
      await deps.lifecycle.stop(input.socketPath, {
        timeoutMs: Math.min(MAX_STOP_ACKNOWLEDGEMENT_MS, remainingHandoffMs(gracefulDeadline, now)),
        expectedObserver: revalidatedIncumbent.health,
      });
    } catch {
      // A timed-out acknowledgement may still have initiated shutdown; exact
      // process evidence below decides whether fallback signaling is safe.
    }

    if (await waitForExactExit(input.socketPath, incumbent, gracefulDeadline, deps, now, sleep)) {
      return { action: "replaced", health };
    }
    if (await exactProcessAndSocketExited(input.socketPath, incumbent, deadline, deps, now)) {
      return { action: "replaced", health };
    }

    if (now() >= deadline) {
      throw handoffRefused("The incumbent Observer did not exit before the handoff deadline.");
    }
    // Health is gated once stop begins, so signal revalidation uses the
    // previously verified identity plus fresh lsof, pidfile, argv, and OS evidence.
    try {
      await requireVerifiedProcessEvidence(input.socketPath, incumbent, deps);
    } catch (error) {
      // Shutdown may remove signal evidence before the exact process exits.
      // Passive identity checks remain safe for the rest of the handoff deadline.
      if (await waitForExactExit(input.socketPath, incumbent, deadline, deps, now, sleep)) {
        return { action: "replaced", health };
      }
      throw error;
    }
    if (now() >= deadline) {
      throw handoffRefused("The incumbent Observer could not be revalidated within the deadline.");
    }
    const signalResult = deps.evidence.signal(incumbent.pid, "SIGTERM");
    if (signalResult === "refused") {
      throw handoffRefused("The incumbent Observer could not be signaled safely.");
    }
    if (await waitForExactExit(input.socketPath, incumbent, deadline, deps, now, sleep)) {
      return { action: "replaced", health };
    }
    throw handoffRefused("The incumbent Observer did not exit before the handoff deadline.");
  } catch (error) {
    if (isObserverHandoffError(error)) throw error;
    throw handoffRefused("The incumbent Observer could not be replaced safely.", error);
  }
}

async function requireVerifiedIncumbent(
  input: { socketPath: string; candidate: ObserverHandoffCandidate },
  health: ObserverHealth,
  deps: ObserverHandoffDeps,
): Promise<{
  processIdentity: ObserverProcessIdentity;
  health: ObserverExpectedProcessHealth;
}> {
  const decision = classifyObserverIncumbent({ candidate: input.candidate, incumbent: health });
  if (decision.action !== "replace") {
    throw handoffRefused(
      decision.action === "refuse"
        ? decision.reason
        : "The incumbent Observer changed before replacement could begin.",
    );
  }
  if (
    health.pid === undefined ||
    health.version === undefined ||
    health.startedAt === undefined ||
    health.socketPath !== input.socketPath
  ) {
    throw handoffRefused("The incumbent Observer did not report complete socket identity.");
  }

  const identity = await deps.evidence.readProcessIdentity(input.socketPath);
  if (
    identity === undefined ||
    identity.pid !== health.pid ||
    identity.version !== health.version ||
    identity.socketPath !== input.socketPath
  ) {
    throw handoffRefused("The incumbent Observer pidfile did not corroborate socket ownership.");
  }
  await requireVerifiedProcessEvidence(input.socketPath, identity, deps);
  return {
    processIdentity: identity,
    health: {
      pid: health.pid,
      startedAt: health.startedAt,
      version: health.version,
      socketPath: health.socketPath,
    },
  };
}

async function requireVerifiedProcessEvidence(
  socketPath: string,
  identity: ObserverProcessIdentity,
  deps: ObserverHandoffDeps,
): Promise<void> {
  const holders = deps.evidence.socketHolders(socketPath);
  if (holders.length !== 1 || holders[0] !== identity.pid) {
    throw handoffRefused("Socket ownership did not match the incumbent Observer identity.");
  }
  const currentIdentity = await deps.evidence.readProcessIdentity(socketPath);
  if (currentIdentity === undefined || !observerProcessIdentitiesMatch(currentIdentity, identity)) {
    throw handoffRefused("The incumbent Observer pidfile changed during handoff.");
  }
  const verification = verifyObserverProcessIdentity(
    { source: "pidfile", identity },
    deps.evidence,
  );
  if (verification.status !== "exact") {
    throw handoffRefused(
      "The incumbent Observer process identity could not be corroborated.",
      verification.cause,
    );
  }
}

async function waitForExactExit(
  socketPath: string,
  identity: ObserverProcessIdentity,
  deadline: number,
  deps: ObserverHandoffDeps,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let pendingInaccessibleError: SafeError | undefined;
  for (;;) {
    if (now() >= deadline) {
      if (pendingInaccessibleError !== undefined) throw pendingInaccessibleError;
      return false;
    }
    try {
      if (await exactProcessAndSocketExited(socketPath, identity, deadline, deps, now)) return true;
      pendingInaccessibleError = undefined;
    } catch (error) {
      if (!isSafeError(error) || error.code !== "OBSERVER_SOCKET_INACCESSIBLE") throw error;
      // A closing exact incumbent can expose a transient inaccessible endpoint; it proves no exit.
      pendingInaccessibleError = error;
    }
    if (now() >= deadline) {
      if (pendingInaccessibleError !== undefined) throw pendingInaccessibleError;
      return false;
    }
    // pi-lens-ignore: await-in-loop
    await sleep(
      Math.min(
        deps.pollIntervalMs ?? DEFAULT_HANDOFF_POLL_INTERVAL_MS,
        Math.max(MIN_HANDOFF_TIMEOUT_MS, deadline - now()),
      ),
    );
  }
}

async function exactProcessAndSocketExited(
  socketPath: string,
  identity: ObserverProcessIdentity,
  deadline: number,
  deps: ObserverHandoffDeps,
  now: () => number,
): Promise<boolean> {
  const listening = await deps.lifecycle.socketListening(socketPath, {
    timeoutMs: remainingHandoffMs(deadline, now),
  });
  const currentStartToken = deps.evidence.processStartToken(identity.pid);
  // Exit proof uses the incumbent PID only because global listings include the live successor.
  const exactProcessExited =
    currentStartToken === undefined
      ? deps.evidence.signal(identity.pid, 0) === "absent"
      : currentStartToken !== identity.osStartTime;
  return !listening && exactProcessExited;
}

function compareSemVer(
  left: z.output<typeof SemVerSchema>,
  right: z.output<typeof SemVerSchema>,
): number {
  for (const index of [0, 1, 2] as const) {
    const compared = compareNumericIdentifier(left.release[index], right.release[index]);
    if (compared !== 0) return compared;
  }
  if (left.prerelease === undefined) return right.prerelease === undefined ? 0 : 1;
  if (right.prerelease === undefined) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const compared = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (compared !== 0) return compared;
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function remainingHandoffMs(deadline: number, now: () => number): number {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) {
    throw handoffRefused("The incumbent Observer did not complete handoff before the deadline.");
  }
  return remaining;
}

function handoffRefused(message: string, cause?: unknown): ObserverHandoffError {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, {
    tag: "ObserverHandoffError",
    code: "OBSERVER_HANDOFF_REFUSED",
    message,
    hint: "Verify the current socket owner, then stop or reap it explicitly before retrying.",
  });
}

function isObserverHandoffError(error: unknown): error is ObserverHandoffError {
  return (
    error instanceof Error && (error as Partial<SafeError>).code === "OBSERVER_HANDOFF_REFUSED"
  );
}

function defaultSleep(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(`${ms} millis`));
}
