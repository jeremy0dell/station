import type {
  HarnessProvider,
  SafeError,
  SessionRecoveryHandle,
  WorktreeObservation,
} from "@station/contracts";
import { resolveHarnessProviderOrThrow } from "../commands/providers.js";
import { commandValidationError } from "../commands/session/shared.js";
import type { SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import {
  type SessionRecoveryEligibility,
  type SessionRecoveryEligibilityInput,
  sessionRecoveryEligibility,
} from "./eligibility.js";
import { selectNewestSessionRecoveryCandidate } from "./selection.js";

type SessionRecoveryExpectation = {
  sessionId: string;
  provider: string;
};

type ResolvedSessionRecovery = {
  handle: SessionRecoveryHandle;
  harness: HarnessProvider;
  resume: Extract<SessionRecoveryEligibility, { kind: "eligible" }>["resume"];
  stationSession?: Extract<SessionRecoveryEligibility, { kind: "eligible" }>["stationSession"];
};

/**
 * USE CASE
 *
 * Filters durable handles through exact lifecycle and provider-neutral eligibility before selecting
 * the newest automatic candidate deterministically, then returns only typed resume authority for
 * that provider. Explicit selection retains imported-handle compatibility only when no
 * contradictory local Station lifecycle exists.
 */
export async function resolveSessionRecovery(input: {
  persistence: SessionStore;
  providers: ProviderRegistry;
  projectId: string;
  worktreeId: string;
  worktree: WorktreeObservation;
  recoveryHandleId?: string | undefined;
  expected?: SessionRecoveryExpectation | undefined;
}): Promise<ResolvedSessionRecovery> {
  const sessions = await input.persistence.listSessions();
  const selected = await resolveRecoveryHandle(input, sessions);
  const handle = selected.handle;
  const harness = resolveHarnessProviderOrThrow(input.providers, handle.provider);
  return {
    handle,
    harness,
    resume: selected.eligibility.resume,
    ...(selected.eligibility.stationSession === undefined
      ? {}
      : { stationSession: selected.eligibility.stationSession }),
  };
}

async function resolveRecoveryHandle(
  input: {
    persistence: SessionStore;
    providers: ProviderRegistry;
    projectId: string;
    worktreeId: string;
    worktree: WorktreeObservation;
    recoveryHandleId?: string | undefined;
    expected?: SessionRecoveryExpectation | undefined;
  },
  sessions: Awaited<ReturnType<SessionStore["listSessions"]>>,
): Promise<{
  handle: SessionRecoveryHandle;
  eligibility: Extract<SessionRecoveryEligibility, { kind: "eligible" }>;
}> {
  if (input.recoveryHandleId !== undefined) {
    const handle = await input.persistence.getSessionRecoveryHandle(input.recoveryHandleId);
    if (handle === undefined) {
      throw commandValidationError({
        code: "SESSION_RECOVERY_HANDLE_NOT_FOUND",
        message: "The requested recovery handle is not available.",
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      });
    }
    const eligibility = evaluateHandle(input, sessions, handle, true);
    if (eligibility.kind === "ineligible") {
      throwSelectedHandleError(input, handle, eligibility.reason);
    }
    return { handle, eligibility };
  }

  const candidates = await input.persistence.listSessionRecoveryHandles({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
  });
  const eligible = candidates.flatMap((handle) => {
    const eligibility = evaluateHandle(input, sessions, handle, false);
    return eligibility.kind === "eligible" ? [{ handle, eligibility }] : [];
  });
  const selected = selectNewestSessionRecoveryCandidate(eligible);
  if (selected !== undefined) {
    return selected;
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_HANDLE_NOT_FOUND",
    message: "No actionable recovery handle is available for this worktree.",
    projectId: input.projectId,
    worktreeId: input.worktreeId,
  });
}

function evaluateHandle(
  input: {
    providers: ProviderRegistry;
    projectId: string;
    worktreeId: string;
    worktree: WorktreeObservation;
    expected?: SessionRecoveryExpectation | undefined;
  },
  sessions: Awaited<ReturnType<SessionStore["listSessions"]>>,
  handle: SessionRecoveryHandle,
  explicitlySelected: boolean,
): SessionRecoveryEligibility {
  const provider = input.providers.harnesses.get(handle.provider);
  const eligibilityInput: SessionRecoveryEligibilityInput = {
    handle,
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    worktreePath: input.worktree.path,
    stationSessions: sessions,
    allowNoLocalSession: explicitlySelected,
  };
  if (input.expected !== undefined) {
    eligibilityInput.expectedSession = {
      id: input.expected.sessionId,
      harness: input.expected.provider,
    };
  }
  if (provider !== undefined) {
    eligibilityInput.registeredHarness = {
      id: provider.id,
      canResume: provider.capabilities().canResume,
    };
  }
  return sessionRecoveryEligibility(eligibilityInput);
}

function throwSelectedHandleError(
  input: { providers: ProviderRegistry; projectId: string; worktreeId: string },
  handle: SessionRecoveryHandle,
  reason: Exclude<SessionRecoveryEligibility, { kind: "eligible" }>["reason"],
): never {
  if (reason === "harness_provider_missing") {
    resolveHarnessProviderOrThrow(input.providers, handle.provider);
  }
  if (reason === "harness_resume_unsupported") {
    throw {
      tag: "HarnessProviderError",
      code: "HARNESS_RESUME_UNSUPPORTED",
      message: "The requested harness provider does not support agent resume.",
      provider: handle.provider,
      worktreeId: handle.worktreeId,
      sessionId: handle.sessionId,
    } satisfies SafeError;
  }
  if (reason === "cwd_missing" || reason === "cwd_outside_worktree") {
    throw commandValidationError({
      code: "SESSION_RECOVERY_CWD_MISMATCH",
      message: "The recovery handle does not prove a cwd inside the requested worktree.",
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      sessionId: handle.sessionId,
    });
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_HANDLE_MISMATCH",
    message: "The recovery handle does not match the canonical open session.",
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    sessionId: handle.sessionId,
  });
}
