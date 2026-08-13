import { randomUUID } from "node:crypto";
import {
  type ProviderId,
  type ProviderProjectConfig,
  type SafeError,
  type SessionGroupId,
  type SessionGroupPlacementIntent,
  type SessionId,
  type SessionView,
  type StationSnapshot,
  type TerminalLaunchProcessRequest,
  type TerminalLaunchProcessResult,
  type TerminalProvider,
  type WorktreeObservation,
  type WorktreeRow,
  worktreeHasLiveAgent,
} from "@station/contracts";
import {
  type RuntimeClock,
  type RuntimeSafeErrorFallback,
  runRuntimeBoundary,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type {
  EventJournal,
  SessionSeedGroupPlacement,
  SessionSeedGroupProvenance,
  SessionSeedResult,
  SessionStore,
} from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { linkAbortSignals, throwIfAborted } from "../cancellation.js";

export { throwIfAborted } from "../cancellation.js";

import {
  sessionGroupIdCollisionError,
  sessionGroupMissingError,
  sessionGroupNotRootError,
  sessionGroupPlacementAssignmentConflictError,
  sessionGroupProjectMismatchError,
} from "../errors.js";
import type { CommandHandlerContext } from "../queue.js";

export { resolveHarnessProviderOrThrow, resolveTerminalProviderOrThrow } from "../providers.js";

export type SessionCommandIdFactory = {
  sessionId(): SessionId;
  sessionGroupId(): SessionGroupId;
};

export type SessionCommandRuntime = {
  clock?: RuntimeClock | undefined;
};

type ProviderMutationTrace = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  operation?: string | undefined;
};

type RunProviderMutationInput = {
  operation: string;
  fallback: RuntimeSafeErrorFallback;
  trace?: ProviderMutationTrace | undefined;
  signal?: AbortSignal | undefined;
} & SessionCommandRuntime;

export const defaultSessionCommandIdFactory: SessionCommandIdFactory = {
  sessionId: () => `ses_${randomUUID()}`,
  sessionGroupId: () => `grp_${randomUUID()}`,
};

/** Converts boundary placement intent into the exact placement owned by SessionStore. */
export function sessionSeedGroupPlacement(
  intent: SessionGroupPlacementIntent | undefined,
  sessionGroupId: SessionCommandIdFactory["sessionGroupId"],
): SessionSeedGroupPlacement | undefined {
  if (intent === undefined || intent.kind === "existing") return intent;
  return { kind: "create", groupId: sessionGroupId(), name: intent.name };
}

export function findProjectOrThrow(
  projects: readonly ProviderProjectConfig[],
  projectId: string,
): ProviderProjectConfig {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project !== undefined) {
    return project;
  }
  throw safeError({
    tag: "CommandValidationError",
    code: "PROJECT_NOT_CONFIGURED",
    message: "This project is not configured in station.",
    hint: "Add the project to config.toml and retry.",
    projectId,
  });
}

export function assertNoCurrentAgent(row: WorktreeRow | undefined): void {
  if (row === undefined || row.agent === undefined || !worktreeHasLiveAgent(row)) {
    return;
  }
  const error: SafeError = {
    tag: "CommandValidationError",
    code: "SESSION_ALREADY_HAS_AGENT",
    message: "This worktree already has a primary agent session.",
    hint: "Focus the existing agent or close it before starting a new one.",
    worktreeId: row.id,
  };
  if (row.agent.sessionId !== undefined) error.sessionId = row.agent.sessionId;
  throw safeError(error);
}

export function worktreeObservationFromRow(
  row: WorktreeRow,
  provider: string,
  observedAt: string,
): WorktreeObservation {
  const observation: WorktreeObservation = {
    id: row.id,
    provider,
    projectId: row.projectId,
    branch: row.branch,
    path: row.path,
    state: row.worktree.state,
    source: row.worktree.source,
    confidence: "high",
    reason: "Resolved from the current observer snapshot.",
    observedAt,
  };
  if (row.registrationIdentity !== undefined) {
    observation.registrationIdentity = row.registrationIdentity;
  }
  if (row.worktree.dirty !== undefined) observation.dirty = row.worktree.dirty;
  if (row.worktree.ahead !== undefined) observation.ahead = row.worktree.ahead;
  if (row.worktree.behind !== undefined) observation.behind = row.worktree.behind;
  if (row.worktree.pr !== undefined) observation.pr = row.worktree.pr;
  if (row.worktree.changeSummary !== undefined) {
    observation.changeSummary = row.worktree.changeSummary;
  }
  if (row.worktree.checks !== undefined) observation.checks = row.worktree.checks;
  return observation;
}

export function commandValidationError(input: {
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

export function validateSnapshotRow(row: WorktreeRow | undefined, projectId: string): void {
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

/**
 * Reuse the worktree's last observed harness before project default; shared by
 * session.startAgent and external launch so both choose identically.
 */
export async function rememberedHarnessProviderForWorktree(input: {
  persistence: SessionStore;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}): Promise<ProviderId | undefined> {
  return input.persistence.findRememberedHarnessProviderForWorktree({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
  });
}

export async function seedSession(input: {
  persistence: SessionStore;
  sessionId: SessionId;
  projectId: string;
  worktreeId: string;
  initialTitle: string;
  group?: SessionSeedGroupPlacement;
  clock?: RuntimeClock | undefined;
}): Promise<Extract<SessionSeedResult, { ok: true }>> {
  const seededAt = toIsoTimestamp((input.clock ?? systemClock).now());
  const result = await input.persistence.seedSession({
    sessionId: input.sessionId,
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    initialTitle: input.initialTitle.trim(),
    createdAt: seededAt,
    lastSeenAt: seededAt,
    ...(input.group === undefined ? {} : { group: input.group }),
  });
  if (result.ok) return result;

  const groupId = input.group?.groupId ?? "generated";
  switch (result.reason) {
    case "group_not_found":
      throw sessionGroupMissingError(groupId, input.projectId);
    case "group_project_mismatch":
      throw sessionGroupProjectMismatchError(groupId, input.projectId);
    case "group_not_root":
      throw sessionGroupNotRootError(groupId, input.projectId);
    case "group_id_collision":
      throw sessionGroupIdCollisionError(input.projectId);
    case "unexpected_assignment":
      throw sessionGroupPlacementAssignmentConflictError(input.projectId);
  }
}

export async function discardSessionSeedBestEffort(input: {
  persistence: SessionStore;
  sessionId: SessionId;
  groupProvenance?: SessionSeedGroupProvenance;
  removedWorktree?: { projectId: string; worktreeId: string };
  context: CommandHandlerContext;
  logger?: StationLogger | undefined;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  try {
    await input.persistence.discardSessionSeed({
      sessionId: input.sessionId,
      ...(input.groupProvenance === undefined ? {} : { groupProvenance: input.groupProvenance }),
      discardedAt: toIsoTimestamp((input.clock ?? systemClock).now()),
      ...(input.removedWorktree === undefined ? {} : { removedWorktree: input.removedWorktree }),
    });
  } catch (error) {
    await input.logger?.warn("Session cleanup failed to discard a pre-launch seed.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      sessionId: input.sessionId,
      error,
    });
  }
}

/** Normalizes one provider call while its concrete adapter owns bounded external settlement. */
export async function runProviderMutation<T>(
  input: RunProviderMutationInput,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const clock = input.clock ?? systemClock;
  const boundaryInput: Parameters<typeof runRuntimeBoundary<T>>[0] = {
    operation: input.operation,
    clock,
    error: input.fallback,
  };
  if (input.trace !== undefined) {
    boundaryInput.trace = input.trace;
  }
  const result = await runRuntimeBoundary(boundaryInput, async ({ signal }) => {
    const linked = linkAbortSignals(signal, input.signal);
    try {
      throwIfAborted(linked.signal);
      const value = await task(linked.signal);
      throwIfAborted(linked.signal);
      return value;
    } finally {
      linked.cleanup();
    }
  });

  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export async function launchHarnessInTerminal(
  input: {
    terminal: TerminalProvider;
    request: TerminalLaunchProcessRequest;
    trace?: ProviderMutationTrace | undefined;
    signal?: AbortSignal | undefined;
  } & SessionCommandRuntime,
): Promise<TerminalLaunchProcessResult> {
  if (input.terminal.launchProcess === undefined) {
    const error: SafeError = {
      tag: "TerminalProviderError",
      code: "TERMINAL_LAUNCH_UNSUPPORTED",
      message: "The configured terminal provider cannot launch harness processes.",
      provider: input.terminal.id,
      worktreeId: input.request.worktree.id,
    };
    if (input.request.terminalTarget.sessionId !== undefined) {
      error.sessionId = input.request.terminalTarget.sessionId;
    }
    throw safeError(error);
  }

  const mutationInput: RunProviderMutationInput = {
    operation: `provider.${input.terminal.id}.launchProcess`,
    fallback: {
      tag: "TerminalProviderError",
      code: "TERMINAL_LAUNCH_FAILED",
      message: "The terminal provider failed to launch the harness process.",
      provider: input.terminal.id,
    },
  };
  if (input.clock !== undefined) mutationInput.clock = input.clock;
  if (input.signal !== undefined) mutationInput.signal = input.signal;
  if (input.trace !== undefined) mutationInput.trace = input.trace;

  const result = await runProviderMutation(
    mutationInput,
    (signal) =>
      input.terminal.launchProcess?.({
        ...input.request,
        signal,
      }) as Promise<TerminalLaunchProcessResult>,
  );
  if (result.started) {
    return result;
  }

  const error: SafeError = {
    tag: "TerminalProviderError",
    code: "TERMINAL_LAUNCH_NOT_STARTED",
    message: "The terminal provider did not confirm that the harness process started.",
    provider: input.terminal.id,
    worktreeId: input.request.worktree.id,
  };
  if (input.request.terminalTarget.sessionId !== undefined) {
    error.sessionId = input.request.terminalTarget.sessionId;
  }
  throw safeError(error);
}

export async function removeWorktreeBestEffort(input: {
  providers: ProviderRegistry;
  project: ProviderProjectConfig;
  worktreeId: string;
  expectedPath: string;
  expectedBranch: string;
  expectedRegistrationIdentity: string | undefined;
  context: CommandHandlerContext;
  logger?: StationLogger | undefined;
  clock?: RuntimeClock | undefined;
}): Promise<boolean> {
  if (input.expectedRegistrationIdentity === undefined) {
    await input.logger?.warn("Session cleanup skipped an unverified worktree removal.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      provider: input.providers.worktree.id,
      operation: "removeWorktree",
      projectId: input.project.id,
      worktreeId: input.worktreeId,
      refusalReason: "registration_unverified",
    });
    return false;
  }
  const expectedRegistrationIdentity = input.expectedRegistrationIdentity;
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.providers.worktree.id}.removeWorktree.cleanup`,
        clock: input.clock,
        trace: input.context.trace,
        fallback: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_CLEANUP_REMOVE_FAILED",
          message: "The worktree provider failed to remove a worktree during cleanup.",
          provider: input.providers.worktree.id,
        },
      },
      () =>
        input.providers.worktree.removeWorktree({
          project: input.project,
          worktreeId: input.worktreeId,
          expectedPath: input.expectedPath,
          expectedBranch: input.expectedBranch,
          expectedRegistrationIdentity,
          force: true,
        }),
    );
    return true;
  } catch (error) {
    await input.logger?.warn("Session cleanup failed to remove worktree.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      provider: input.providers.worktree.id,
      operation: "removeWorktree",
      projectId: input.project.id,
      worktreeId: input.worktreeId,
      error,
    });
    return false;
  }
}

export async function publishSessionCreated(input: {
  snapshot: StationSnapshot;
  sessionId: SessionId;
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
}): Promise<SessionView | undefined> {
  const session = input.snapshot.sessions.find((candidate) => candidate.id === input.sessionId);
  if (session === undefined) {
    return undefined;
  }

  const event = { type: "session.created" as const, session };
  await input.persistence.recordEvent(event, {
    commandId: input.context.commandId,
    traceId: input.context.trace.traceId,
    spanId: input.context.trace.spanId,
    createdAt: toIsoTimestamp((input.clock ?? systemClock).now()),
  });
  input.eventBus?.publish(event);
  return session;
}

function safeError(input: SafeError): SafeError {
  return input;
}
