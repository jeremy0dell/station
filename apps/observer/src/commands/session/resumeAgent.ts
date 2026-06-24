import type {
  EnsureAgentWorkspaceIntent,
  HarnessProvider,
  HarnessResumeOptions,
  ProviderProjectConfig,
  SafeError,
  SessionRecoveryHandle,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import { pathIsSameOrInside } from "@station/runtime";
import type { FeatureFlagEvaluator } from "../../features/evaluator.js";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
import { worktreeMissingError } from "../errors.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  defaultSessionCommandIdFactory,
  findProjectOrThrow,
  publishSessionCreated,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSessionTitle,
  throwIfAborted,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreateSessionResumeAgentHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: ObserverPersistence;
  featureFlags: FeatureFlagEvaluator;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  commandTimeoutMs?: number | undefined;
};

export function createSessionResumeAgentHandler(
  options: CreateSessionResumeAgentHandlerOptions,
): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.resumeAgent");
    throwIfAborted(context.signal);

    // The command is registered unconditionally so old clients get a stable
    // SafeError instead of an unknown-command failure while the feature bakes.
    if (!options.featureFlags.enabled("sessionResumeAgent")) {
      throw commandValidationError({
        code: "SESSION_RESUME_DISABLED",
        message: "Agent resume is disabled.",
        hint: "Enable feature_flags.sessionResumeAgent and retry.",
      });
    }

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    const terminalProviderId = payload.terminal?.provider ?? project.defaults.terminal;
    resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
    const snapshot = options.core.getSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    validateSnapshotRow(row, payload.projectId);
    // Resume is recovery for a lost primary agent, not a second way to launch
    // another provider process next to a healthy row.
    assertResumeAllowed(row);

    const runtime = {
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      signal: context.signal,
      trace: context.trace,
    };
    const worktree =
      row === undefined
        ? await lookupWorktree({
            providers: options.providers,
            projectId: payload.projectId,
            worktreeId: payload.worktreeId,
            runtime,
          })
        : worktreeObservationFromRow(row, options.providers.worktree.id, nowIso(options.clock));
    throwIfAborted(context.signal);

    const handle = await resolveRecoveryHandle({
      persistence: options.persistence,
      providers: options.providers,
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      recoveryHandleId: payload.recoveryHandleId,
    });
    // A provider-native target may outlive the worktree that produced it; keep
    // recovery tied to the observed cwd/worktree boundary when available.
    assertHandleMatchesWorktree(handle, worktree);
    const harnessProvider = resolveHarnessProviderOrThrow(options.providers, handle.provider);
    assertHarnessCanResume(harnessProvider, handle);

    const sessionId = handle.sessionId ?? idFactory.sessionId();
    // Resume may reuse an existing session row, so failed launch cleanup must
    // not delete metadata. A stray new seed is cheaper than deleting the user's
    // known title/session record after a provider launch failure.
    await seedSessionTitle({
      persistence: options.persistence,
      sessionId,
      projectId: project.id,
      worktreeId: worktree.id,
      title: worktree.branch,
      clock: options.clock,
    });
    throwIfAborted(context.signal);

    const receipt = await options.providers.terminalIntentRunner.submitIntent(
      ensureAgentWorkspaceIntent({
        commandId: context.commandId,
        project,
        worktree,
        sessionId,
        terminalProvider: terminalProviderId,
        harnessProvider: handle.provider,
        layout: payload.terminal?.layout ?? project.defaults.layout,
        focus: payload.terminal?.focus,
        origin: payload.terminal?.origin,
        initialPrompt: payload.initialPrompt,
        recoveryHandle: handle,
      }),
      {
        trace: context.trace,
        signal: context.signal,
        commandTimeoutMs: options.commandTimeoutMs,
      },
    );
    if (receipt.status === "rejected") {
      throw receipt.error;
    }
    throwIfAborted(context.signal);

    const nextSnapshot = await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.resumeAgent",
      trace: context.trace,
    });
    await publishSessionCreated({
      snapshot: nextSnapshot,
      sessionId,
      persistence: options.persistence,
      eventBus: options.eventBus,
      context,
      clock: options.clock,
    });
  };
}

function ensureAgentWorkspaceIntent(input: {
  commandId: string;
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  sessionId: string;
  terminalProvider: string;
  harnessProvider: string;
  layout: string;
  focus?: boolean | undefined;
  origin?: EnsureAgentWorkspaceIntent["origin"] | undefined;
  initialPrompt?: string | undefined;
  recoveryHandle: SessionRecoveryHandle;
}): EnsureAgentWorkspaceIntent {
  // The terminal runner remains provider-neutral: it opens/focuses the pane,
  // and the harness adapter alone translates this resume target into CLI args.
  const resume: HarnessResumeOptions = {
    target: input.recoveryHandle.target,
    recoveryHandleId: input.recoveryHandle.id,
  };
  if (input.recoveryHandle.sessionId !== undefined) {
    resume.previousSessionId = input.recoveryHandle.sessionId;
  }

  const intent: EnsureAgentWorkspaceIntent = {
    type: "session.ensureAgentWorkspace",
    commandId: input.commandId,
    terminalProvider: input.terminalProvider,
    project: input.project,
    worktree: input.worktree,
    sessionId: input.sessionId,
    harness: {
      provider: input.harnessProvider,
      mode: "interactive",
    },
    layout: input.layout,
    resume,
  };
  if (input.focus !== undefined) intent.focus = input.focus;
  if (input.origin !== undefined) intent.origin = input.origin;
  if (input.initialPrompt !== undefined) intent.initialPrompt = input.initialPrompt;
  return intent;
}

async function resolveRecoveryHandle(input: {
  persistence: ObserverPersistence;
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

  // Automatic resume requires one exact persisted handle; picker/latest semantics stay manual.
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

function assertHarnessCanResume(provider: HarnessProvider, handle: SessionRecoveryHandle): void {
  // canResume is configuration-gated; adapter code may support resume but a
  // project must still opt in before observer commands use it.
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
): void {
  if (handle.cwd === undefined || pathIsSameOrInside(handle.cwd, worktree.path)) {
    return;
  }
  throw commandValidationError({
    code: "SESSION_RECOVERY_CWD_MISMATCH",
    message: "The recovery handle was observed outside the requested worktree.",
    projectId: handle.projectId,
    worktreeId: handle.worktreeId,
    sessionId: handle.sessionId,
  });
}

function validateSnapshotRow(row: WorktreeRow | undefined, projectId: string): void {
  if (row === undefined || row.projectId === projectId) {
    return;
  }
  throw commandValidationError({
    code: "WORKTREE_PROJECT_MISMATCH",
    message: "The requested worktree belongs to a different configured project.",
    projectId,
    worktreeId: row.id,
  });
}

function assertResumeAllowed(row: WorktreeRow | undefined): void {
  // Relaunchable states (no agent / none / exited, and unknown with a stale or
  // missing terminal — the crash-recovery case) fall through. A genuinely live
  // agent — including unknown with an open, still-focusable target — is not
  // overwritten. One shared predicate so resume and the Station launch agree.
  if (row === undefined || !worktreeHasLiveAgent(row)) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "SESSION_ALREADY_HAS_AGENT",
    message: "This worktree already has a primary agent session.",
    hint: "Focus the existing agent or close it before resuming an agent.",
    worktreeId: row.id,
  };
  if (row.agent?.sessionId !== undefined) error.sessionId = row.agent.sessionId;
  throw error;
}

async function lookupWorktree(input: {
  providers: ProviderRegistry;
  projectId: string;
  worktreeId: string;
  runtime: {
    clock?: RuntimeClock | undefined;
    commandTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    trace?:
      | {
          traceId?: string | undefined;
          spanId?: string | undefined;
          operation?: string | undefined;
        }
      | undefined;
  };
}): Promise<WorktreeObservation> {
  if (input.providers.worktree.getWorktree === undefined) {
    throw worktreeMissingError({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      message: "The requested worktree is not visible to the worktree provider.",
    });
  }

  const worktree = await runProviderMutation(
    {
      ...input.runtime,
      operation: `provider.${input.providers.worktree.id}.getWorktree`,
      fallback: {
        tag: "WorktreeProviderError",
        code: "WORKTREE_LOOKUP_FAILED",
        message: "The worktree provider failed to look up the worktree.",
        provider: input.providers.worktree.id,
      },
    },
    () =>
      input.providers.worktree.getWorktree?.({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      }) as Promise<WorktreeObservation | null>,
  );
  if (worktree === null) {
    throw worktreeMissingError({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      message: "The requested worktree is not visible to the worktree provider.",
    });
  }
  return worktree;
}

function commandValidationError(input: {
  code: string;
  message: string;
  hint?: string | undefined;
  projectId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
}): SafeError {
  const error: SafeError = {
    tag: "CommandValidationError",
    code: input.code,
    message: input.message,
  };
  if (input.hint !== undefined) error.hint = input.hint;
  if (input.projectId !== undefined) error.projectId = input.projectId;
  if (input.worktreeId !== undefined) error.worktreeId = input.worktreeId;
  if (input.sessionId !== undefined) error.sessionId = input.sessionId;
  return error;
}
