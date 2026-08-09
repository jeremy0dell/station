import type {
  HarnessProvider,
  HarnessResumeOptions,
  SafeError,
  SessionRecoveryHandle,
  WorktreeObservation,
} from "@station/contracts";
import { pathIsSameOrInside } from "@station/runtime";
import { resolveHarnessProviderOrThrow } from "./commands/providers.js";
import { commandValidationError } from "./commands/session/shared.js";
import type { SessionStore } from "./persistence/index.js";
import type { ProviderRegistry } from "./providers/registry.js";

type SessionRecoveryExpectation = {
  sessionId: string;
  provider: string;
};

type ResolvedSessionRecovery = {
  handle: SessionRecoveryHandle;
  harness: HarnessProvider;
  resume: HarnessResumeOptions;
};

/**
 * USE CASE
 *
 * Resolves one provider-native recovery handle through durable session state and
 * provider capability, returning only typed provider-neutral resume authority.
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
  const handle = await resolveRecoveryHandle(input);
  assertHandleMatchesExpectation(handle, input.expected);
  assertHandleMatchesWorktree(handle, input.worktree, input.expected !== undefined);
  const harness = resolveHarnessProviderOrThrow(input.providers, handle.provider);
  assertHarnessCanResume(harness, handle);

  const resume: HarnessResumeOptions = {
    target: handle.target,
    recoveryHandleId: handle.id,
  };
  if (handle.sessionId !== undefined) {
    resume.previousSessionId = handle.sessionId;
  }
  return { handle, harness, resume };
}

async function resolveRecoveryHandle(input: {
  persistence: SessionStore;
  providers: ProviderRegistry;
  projectId: string;
  worktreeId: string;
  recoveryHandleId?: string | undefined;
}): Promise<SessionRecoveryHandle> {
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
    if (handle.projectId !== input.projectId || handle.worktreeId !== input.worktreeId) {
      throw commandValidationError({
        code: "SESSION_RECOVERY_HANDLE_MISMATCH",
        message: "The requested recovery handle belongs to a different worktree.",
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      });
    }
    return handle;
  }

  // Automatic recovery is exact only when provider capability leaves one choice.
  const handles = (
    await input.persistence.listSessionRecoveryHandles({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
    })
  ).filter((handle) => handleIsActionable(handle, input.providers));
  if (handles.length === 1) {
    return handles[0] as SessionRecoveryHandle;
  }
  if (handles.length > 1) {
    throw commandValidationError({
      code: "SESSION_RECOVERY_HANDLE_AMBIGUOUS",
      message: "More than one recovery handle is available for this worktree.",
      hint: "Select a specific recovery handle and retry.",
      projectId: input.projectId,
      worktreeId: input.worktreeId,
    });
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_HANDLE_NOT_FOUND",
    message: "No actionable recovery handle is available for this worktree.",
    projectId: input.projectId,
    worktreeId: input.worktreeId,
  });
}

function handleIsActionable(handle: SessionRecoveryHandle, providers: ProviderRegistry): boolean {
  return providers.harnesses.get(handle.provider)?.capabilities().canResume === true;
}

function assertHandleMatchesExpectation(
  handle: SessionRecoveryHandle,
  expected: SessionRecoveryExpectation | undefined,
): void {
  if (
    expected === undefined ||
    (handle.sessionId === expected.sessionId && handle.provider === expected.provider)
  ) {
    return;
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_HANDLE_MISMATCH",
    message: "The recovery handle does not match the canonical open session.",
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    sessionId: expected.sessionId,
  });
}

function assertHarnessCanResume(provider: HarnessProvider, handle: SessionRecoveryHandle): void {
  // canResume is configuration-gated even when the adapter implements resume mechanics.
  if (provider.capabilities().canResume) {
    return;
  }
  throw {
    tag: "HarnessProviderError",
    code: "HARNESS_RESUME_UNSUPPORTED",
    message: "The requested harness provider does not support agent resume.",
    provider: provider.id,
    worktreeId: handle.worktreeId,
    sessionId: handle.sessionId,
  } satisfies SafeError;
}

function assertHandleMatchesWorktree(
  handle: SessionRecoveryHandle,
  worktree: WorktreeObservation,
  requireCwd: boolean,
): void {
  if (
    (handle.cwd === undefined && !requireCwd) ||
    (handle.cwd !== undefined && pathIsSameOrInside(handle.cwd, worktree.path))
  ) {
    return;
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_CWD_MISMATCH",
    message: "The recovery handle does not prove a cwd inside the requested worktree.",
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    sessionId: handle.sessionId,
  });
}
