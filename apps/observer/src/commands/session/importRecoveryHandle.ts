import type {
  ProviderProjectConfig,
  SafeError,
  SessionRecoveryHandle,
  WorktreeRow,
} from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import { pathIsSameOrInside } from "@station/runtime";
import type { FeatureFlagEvaluator } from "../../features/evaluator.js";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  commandValidationError,
  findProjectOrThrow,
  resolveHarnessProviderOrThrow,
  throwIfAborted,
} from "./shared.js";

export type CreateSessionImportRecoveryHandleHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  featureFlags: FeatureFlagEvaluator;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

/**
 * USE CASE
 *
 * Atomically imports one verified provider-native recovery identity and optional
 * canonical title into an idle target before reconcile can expose it for resume.
 */
export function createSessionImportRecoveryHandleHandler(
  options: CreateSessionImportRecoveryHandleHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "session.importRecoveryHandle");
    throwIfAborted(context.signal);

    if (!options.featureFlags.enabled("sessionResumeAgent")) {
      throw commandValidationError({
        code: "SESSION_RESUME_DISABLED",
        message: "Agent resume is disabled.",
        hint: "Enable feature_flags.session_resume_agent, restart the target Observer, and retry.",
      });
    }

    const payload = context.command.payload;
    findProjectOrThrow(options.getProjects(), payload.projectId);
    const row = options.core
      .getSnapshot()
      .rows.find((candidate) => candidate.id === payload.worktreeId);
    assertImportTarget(row, payload);
    assertPersistentManagedLaunch(options.providers);

    const provider = resolveHarnessProviderOrThrow(options.providers, payload.handle.provider);
    if (!provider.capabilities().canResume) {
      throw recoveryError(payload.handle, {
        code: "HARNESS_RESUME_UNSUPPORTED",
        message: "The requested harness provider does not support agent resume.",
        provider: provider.id,
      });
    }

    const existing = await options.persistence.listSessionRecoveryHandles({
      provider: payload.handle.provider,
    });
    assertNoRecoveryIdentityConflict(existing, payload.handle);
    const importInput: Parameters<SessionStore["importSessionRecoveryHandle"]>[0] = {
      handle: payload.handle,
      importedAt: nowIso(options.clock),
    };
    if (payload.title !== undefined) importInput.title = payload.title;
    await options.persistence.importSessionRecoveryHandle(importInput);
    throwIfAborted(context.signal);

    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.importRecoveryHandle",
      trace: context.trace,
    });
  };
}

function assertImportTarget(
  row: WorktreeRow | undefined,
  payload: {
    projectId: string;
    worktreeId: string;
    expectedPath: string;
    expectedRegistrationIdentity?: string | undefined;
    handle: SessionRecoveryHandle;
  },
): asserts row is WorktreeRow {
  if (row === undefined || row.projectId !== payload.projectId) {
    throw commandValidationError({
      code: "WORKTREE_NOT_FOUND",
      message: "The recovery target worktree is not present in the target snapshot.",
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
  }
  if (
    row.path !== payload.expectedPath ||
    (payload.expectedRegistrationIdentity !== undefined &&
      row.registrationIdentity !== payload.expectedRegistrationIdentity)
  ) {
    throw commandValidationError({
      code: "SESSION_RECOVERY_WORKTREE_MISMATCH",
      message: "The target worktree identity changed after migration planning.",
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
  }
  if (
    payload.handle.projectId !== payload.projectId ||
    payload.handle.worktreeId !== payload.worktreeId ||
    payload.handle.sessionId === undefined ||
    payload.handle.cwd === undefined ||
    !pathIsSameOrInside(payload.handle.cwd, payload.expectedPath)
  ) {
    throw commandValidationError({
      code: "SESSION_RECOVERY_HANDLE_MISMATCH",
      message: "The recovery handle does not belong to the target worktree.",
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      sessionId: payload.handle.sessionId,
    });
  }
  if (worktreeHasLiveAgent(row)) {
    throw commandValidationError({
      code: "SESSION_ALREADY_HAS_AGENT",
      message: "The target worktree already has a primary agent session.",
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      sessionId: row.agent?.sessionId,
    });
  }
}

function assertPersistentManagedLaunch(providers: ProviderRegistry): void {
  const managedTerminal = providers.managedTerminal;
  if (managedTerminal?.capabilities().canLaunchProcessPersistently === true) return;
  throw commandValidationError({
    code: "SESSION_RECOVERY_PERSISTENT_TERMINAL_REQUIRED",
    message: "Session migration requires a persistent managed terminal target.",
    hint: "Enable feature_flags.station_persistent_agents, restart the target Observer, and retry.",
  });
}

function assertNoRecoveryIdentityConflict(
  existing: readonly SessionRecoveryHandle[],
  incoming: SessionRecoveryHandle,
): void {
  const conflict = existing.find(
    (candidate) =>
      sameTarget(candidate, incoming) &&
      (candidate.projectId !== incoming.projectId ||
        candidate.worktreeId !== incoming.worktreeId ||
        candidate.sessionId !== incoming.sessionId),
  );
  if (conflict === undefined) return;
  throw recoveryError(incoming, {
    code: "SESSION_RECOVERY_IDENTITY_CONFLICT",
    message: "The provider-native recovery identity already belongs to another target session.",
    provider: incoming.provider,
  });
}

function sameTarget(left: SessionRecoveryHandle, right: SessionRecoveryHandle): boolean {
  if (left.provider !== right.provider || left.target.kind !== right.target.kind) return false;
  if (left.target.kind === "native-session") {
    return right.target.kind === "native-session" && left.target.id === right.target.id;
  }
  return right.target.kind === "session-file" && left.target.path === right.target.path;
}

function recoveryError(
  handle: SessionRecoveryHandle,
  input: Pick<SafeError, "code" | "message" | "provider">,
): SafeError {
  const error: SafeError = {
    tag: "CommandValidationError",
    code: input.code,
    message: input.message,
    provider: input.provider,
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
  };
  if (handle.sessionId !== undefined) error.sessionId = handle.sessionId;
  return error;
}
