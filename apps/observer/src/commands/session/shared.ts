import { randomUUID } from "node:crypto";
import type {
  ProviderId,
  ProviderProjectConfig,
  SafeError,
  SessionId,
  SessionView,
  StationSnapshot,
  TerminalFocusOrigin,
  TerminalLaunchProcessRequest,
  TerminalLaunchProcessResult,
  TerminalProvider,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import { sameObservedPath } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import {
  type RuntimeClock,
  type RuntimeSafeErrorFallback,
  runRuntimeBoundaryWithTimeout,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { linkAbortSignals, throwIfAborted } from "../cancellation.js";

export { throwIfAborted } from "../cancellation.js";

import type { CommandHandlerContext } from "../queue.js";

export { resolveHarnessProviderOrThrow, resolveTerminalProviderOrThrow } from "../providers.js";

export type SessionCommandIdFactory = {
  sessionId(): SessionId;
};

export type SessionCommandRuntime = {
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
};

type ProviderMutationTrace = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  operation?: string | undefined;
};

type RunProviderMutationInput = {
  operation: string;
  fallback: RuntimeSafeErrorFallback;
  timeoutFallback?: RuntimeSafeErrorFallback | undefined;
  trace?: ProviderMutationTrace | undefined;
  signal?: AbortSignal | undefined;
} & SessionCommandRuntime;

export const defaultSessionCommandIdFactory: SessionCommandIdFactory = {
  sessionId: () => `ses_${randomUUID()}`,
};

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
  if (row?.agent === undefined) {
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

/**
 * Reuse the worktree's last observed harness before project default; shared by
 * session.startAgent and external launch so both choose identically.
 */
export async function rememberedHarnessProviderForWorktree(input: {
  persistence: ObserverPersistence;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
}): Promise<ProviderId | undefined> {
  const [sessions, worktrees] = await Promise.all([
    input.persistence.listSessions(),
    input.persistence.listWorktrees(),
  ]);
  const matchingWorktreeIds = new Set([input.worktreeId]);
  for (const worktree of worktrees) {
    if (
      worktree.projectId === input.projectId &&
      sameObservedPath(worktree.path, input.worktreePath)
    ) {
      matchingWorktreeIds.add(worktree.id);
    }
  }
  return sessions
    .filter(
      (session) =>
        session.projectId === input.projectId &&
        matchingWorktreeIds.has(session.worktreeId) &&
        session.harness !== undefined,
    )
    .sort(compareRecentSessions)[0]?.harness;
}

function compareRecentSessions(
  left: { id: string; createdAt: string; lastSeenAt: string },
  right: { id: string; createdAt: string; lastSeenAt: string },
): number {
  return (
    right.lastSeenAt.localeCompare(left.lastSeenAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

export async function seedSessionTitle(input: {
  persistence: ObserverPersistence;
  sessionId: SessionId;
  projectId: string;
  worktreeId: string;
  title: string;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  const seededAt = toIsoTimestamp((input.clock ?? systemClock).now());
  await input.persistence.seedSessionTitle({
    sessionId: input.sessionId,
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    title: input.title.trim(),
    createdAt: seededAt,
    lastSeenAt: seededAt,
  });
}

export async function deleteSessionTitleSeedBestEffort(input: {
  persistence: ObserverPersistence;
  sessionId: SessionId;
  context: CommandHandlerContext;
  logger?: JsonlLogger | undefined;
}): Promise<void> {
  try {
    await input.persistence.deleteSessionTitleSeed(input.sessionId);
  } catch (error) {
    await input.logger?.warn("Session cleanup failed to delete a pre-launch title seed.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      sessionId: input.sessionId,
      error,
    });
  }
}

export async function runProviderMutation<T>(
  input: RunProviderMutationInput,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const clock = input.clock ?? systemClock;
  const boundaryInput: Parameters<typeof runRuntimeBoundaryWithTimeout<T>>[0] = {
    operation: input.operation,
    clock,
    timeoutMs: input.commandTimeoutMs ?? 30_000,
    error: input.fallback,
  };
  if (input.timeoutFallback !== undefined) {
    boundaryInput.timeoutError = input.timeoutFallback;
  }
  if (input.trace !== undefined) {
    boundaryInput.trace = input.trace;
  }
  const result = await runRuntimeBoundaryWithTimeout(boundaryInput, async ({ signal }) => {
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
    timeoutFallback: {
      tag: "TimeoutError",
      code: "TERMINAL_LAUNCH_TIMEOUT",
      message: "The terminal provider timed out while launching the harness process.",
      provider: input.terminal.id,
    },
  };
  if (input.clock !== undefined) mutationInput.clock = input.clock;
  if (input.commandTimeoutMs !== undefined) mutationInput.commandTimeoutMs = input.commandTimeoutMs;
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

export async function closeTerminalTargetBestEffort(input: {
  terminal: TerminalProvider;
  targetId: string;
  context: CommandHandlerContext;
  logger?: JsonlLogger | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
}): Promise<void> {
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.terminal.id}.closeTarget.cleanup`,
        clock: input.clock,
        commandTimeoutMs: cleanupTimeoutMs(input.commandTimeoutMs),
        trace: input.context.trace,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_CLEANUP_CLOSE_FAILED",
          message: "The terminal provider failed to close a target during cleanup.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.closeTarget(input.targetId),
    );
  } catch (error) {
    await input.logger?.warn("Session cleanup failed to close terminal target.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      provider: input.terminal.id,
      operation: "closeTarget",
      targetId: input.targetId,
      error,
    });
  }
}

export async function removeWorktreeBestEffort(input: {
  providers: ProviderRegistry;
  projectId: string;
  worktreeId: string;
  context: CommandHandlerContext;
  logger?: JsonlLogger | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
}): Promise<void> {
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.providers.worktree.id}.removeWorktree.cleanup`,
        clock: input.clock,
        commandTimeoutMs: cleanupTimeoutMs(input.commandTimeoutMs),
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
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          force: true,
        }),
    );
  } catch (error) {
    await input.logger?.warn("Session cleanup failed to remove worktree.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      provider: input.providers.worktree.id,
      operation: "removeWorktree",
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      error,
    });
  }
}

export async function focusTerminalTargetBestEffort(input: {
  terminal: TerminalProvider;
  targetId: string;
  origin?: TerminalFocusOrigin | undefined;
  context: CommandHandlerContext;
  logger?: JsonlLogger | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
}): Promise<void> {
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.terminal.id}.focusTarget`,
        clock: input.clock,
        commandTimeoutMs: input.commandTimeoutMs,
        signal: input.context.signal,
        trace: input.context.trace,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_FOCUS_FAILED",
          message: "The terminal provider failed to focus the session target.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.focusTarget(input.targetId, focusContext(input.origin)),
    );
  } catch (error) {
    await input.logger?.warn("Terminal focus failed after session launch.", {
      commandId: input.context.commandId,
      traceId: input.context.trace.traceId,
      provider: input.terminal.id,
      operation: "focusTarget",
      targetId: input.targetId,
      error,
    });
  }
}

function focusContext(
  origin: TerminalFocusOrigin | undefined,
): { origin?: TerminalFocusOrigin } | undefined {
  if (origin === undefined) {
    return undefined;
  }
  return { origin };
}

export async function publishSessionCreated(input: {
  snapshot: StationSnapshot;
  sessionId: SessionId;
  persistence: ObserverPersistence;
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

function cleanupTimeoutMs(commandTimeoutMs: number | undefined): number {
  return Math.min(commandTimeoutMs ?? 30_000, 5_000);
}
