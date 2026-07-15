import type {
  HarnessProvider,
  HarnessRunId,
  SafeError,
  SessionView,
  TerminalProvider,
  TerminalTargetId,
  WorktreeRow,
} from "@station/contracts";
import { isRunningAgentState, SafeErrorSchema } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { ProviderRegistry } from "../../providers/registry.js";
import { resolveHarnessProviderOrThrow } from "../providers.js";
import type { CommandHandlerContext } from "../queue.js";
import { runProviderMutation, throwIfAborted } from "../session/shared.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";
import {
  hasCloseableTerminalAttachment,
  submitTerminalIntentOrThrow,
  terminalCloseIntentForSession,
  terminalCloseIntentForWorktree,
} from "../terminalIntents.js";
import type { VerifiedWorktreeRemovalTarget } from "./guards.js";

export type CleanupRuntime = {
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
};

export async function closeSessionResources(
  input: {
    providers: ProviderRegistry;
    terminalIntentRunner: TerminalIntentRunner;
    session: SessionView;
    row?: WorktreeRow | undefined;
    mode: "harness" | "terminal" | "all";
    force: boolean;
    context: CommandHandlerContext;
    requireTerminalClose?: boolean | undefined;
  } & CleanupRuntime,
): Promise<void> {
  if (input.mode === "harness" || input.mode === "all") {
    // Only tolerate an unsupported stop when there is a terminal-close fallback
    // that will actually retire the session. Otherwise force must NOT report a
    // hollow success on a stop-less provider — the process keeps running and the
    // row reappears each reconcile; error honestly instead (a stale/ghost row is
    // cleared by busy-status decay, not by a fake stop).
    await stopHarnessForSession({
      ...input,
      allowUnsupportedStop: input.mode === "all" && canUseTerminalCloseFallbackForSession(input),
    });
  }
  throwIfAborted(input.context.signal);

  if (input.mode === "terminal" || input.mode === "all") {
    if (!hasCloseableTerminalAttachment({ session: input.session, row: input.row })) {
      if (input.requireTerminalClose !== true) {
        return;
      }
      const error: SafeError = {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        message: "No terminal is open for this session.",
        hint: "Refresh the dashboard and retry.",
        provider:
          input.session.terminal?.provider ??
          input.row?.terminal?.provider ??
          input.providers.defaultTerminalId,
        sessionId: input.session.id,
        worktreeId: input.session.worktreeId,
      };
      throw error;
    }
    await submitTerminalIntentOrThrow({
      terminalIntentRunner: input.terminalIntentRunner,
      intent: terminalCloseIntentForSession({
        defaultTerminalId: input.providers.defaultTerminalId,
        commandId: input.context.commandId,
        session: input.session,
        row: input.row,
        force: input.force,
      }),
      context: input.context,
      commandTimeoutMs: input.commandTimeoutMs,
    });
  }
}

export async function stopHarnessForWorktree(
  input: {
    providers: ProviderRegistry;
    row: WorktreeRow;
    force: boolean;
    context: CommandHandlerContext;
    allowUnsupportedStop?: boolean | undefined;
  } & CleanupRuntime,
): Promise<void> {
  if (input.row.agent === undefined || !isRunningAgentState(input.row.agent.state)) {
    return;
  }
  const provider = resolveHarnessProviderOrThrow(input.providers, input.row.agent.harness);
  await stopHarnessRun({
    provider,
    runId: input.row.agent.runId,
    sessionId: input.row.agent.sessionId,
    worktreeId: input.row.id,
    force: input.force,
    allowUnsupportedStop: input.allowUnsupportedStop === true,
    context: input.context,
    clock: input.clock,
    commandTimeoutMs: input.commandTimeoutMs,
  });
}

export async function closeTerminalForWorktree(
  input: {
    providers: ProviderRegistry;
    terminalIntentRunner: TerminalIntentRunner;
    row: WorktreeRow;
    force: boolean;
    context: CommandHandlerContext;
  } & CleanupRuntime,
): Promise<void> {
  if (!hasCloseableTerminalAttachment({ row: input.row })) {
    return;
  }
  try {
    await submitTerminalIntentOrThrow({
      terminalIntentRunner: input.terminalIntentRunner,
      intent: terminalCloseIntentForWorktree({
        defaultTerminalId: input.providers.defaultTerminalId,
        commandId: input.context.commandId,
        row: input.row,
        force: input.force,
      }),
      context: input.context,
      commandTimeoutMs: input.commandTimeoutMs,
    });
  } catch (error) {
    if (input.force && terminalTargetMissing(error)) {
      return;
    }
    throw error;
  }
}

export async function closeTerminalTarget(
  input: {
    terminal: TerminalProvider;
    targetId: TerminalTargetId;
    context: CommandHandlerContext;
  } & CleanupRuntime,
): Promise<void> {
  await runProviderMutation(
    {
      operation: `provider.${input.terminal.id}.closeTarget`,
      clock: input.clock,
      commandTimeoutMs: input.commandTimeoutMs,
      signal: input.context.signal,
      trace: input.context.trace,
      fallback: {
        tag: "TerminalProviderError",
        code: "TERMINAL_CLOSE_FAILED",
        message: "The terminal provider failed to close the target.",
        provider: input.terminal.id,
      },
      timeoutFallback: {
        tag: "TimeoutError",
        code: "TERMINAL_CLOSE_TIMEOUT",
        message: "The terminal provider timed out while closing the target.",
        provider: input.terminal.id,
      },
    },
    () => input.terminal.closeTarget(input.targetId),
  );
}

export async function removeWorktreeThroughProvider(
  input: {
    providers: ProviderRegistry;
    row: WorktreeRow;
    target: VerifiedWorktreeRemovalTarget;
    force: boolean;
    context: CommandHandlerContext;
  } & CleanupRuntime,
): Promise<void> {
  const request = {
    worktreeId: input.row.id,
    projectId: input.row.projectId,
    expectedPath: input.target.path,
    expectedBranch: input.target.branch,
    expectedRegistrationIdentity: input.target.registrationIdentity,
  };
  const providerRequest: typeof request & { force?: boolean } = { ...request };
  if (input.force) {
    providerRequest.force = true;
  }
  const result = await runProviderMutation(
    {
      operation: `provider.${input.providers.worktree.id}.removeWorktree`,
      clock: input.clock,
      commandTimeoutMs: input.commandTimeoutMs,
      signal: input.context.signal,
      trace: input.context.trace,
      fallback: {
        tag: "WorktreeProviderError",
        code: "WORKTREE_REMOVE_FAILED",
        message: "The worktree provider failed to remove the worktree.",
        provider: input.providers.worktree.id,
      },
      timeoutFallback: {
        tag: "TimeoutError",
        code: "WORKTREE_REMOVE_TIMEOUT",
        message: "The worktree provider timed out while removing the worktree.",
        provider: input.providers.worktree.id,
      },
    },
    () => input.providers.worktree.removeWorktree(providerRequest),
  );

  if (!result.removed) {
    const error: SafeError = {
      tag: "WorktreeProviderError",
      code: "WORKTREE_REMOVE_NOT_CONFIRMED",
      message: "The worktree provider did not confirm removal.",
      provider: input.providers.worktree.id,
      projectId: input.row.projectId,
      worktreeId: input.row.id,
    };
    throw error;
  }
}

async function stopHarnessForSession(
  input: {
    providers: ProviderRegistry;
    session: SessionView;
    row?: WorktreeRow | undefined;
    force: boolean;
    context: CommandHandlerContext;
    allowUnsupportedStop?: boolean | undefined;
  } & CleanupRuntime,
): Promise<void> {
  if (!isRunningAgentState(input.row?.agent?.state ?? input.session.status.value)) {
    return;
  }
  const providerId = input.row?.agent?.harness ?? input.session.harness.provider;
  const runId = input.row?.agent?.runId ?? input.session.harness.runId;
  const provider = resolveHarnessProviderOrThrow(input.providers, providerId);
  await stopHarnessRun({
    provider,
    runId,
    sessionId: input.session.id,
    worktreeId: input.session.worktreeId,
    force: input.force,
    allowUnsupportedStop: input.allowUnsupportedStop === true,
    context: input.context,
    clock: input.clock,
    commandTimeoutMs: input.commandTimeoutMs,
  });
}

async function stopHarnessRun(
  input: {
    provider: HarnessProvider;
    runId: HarnessRunId | undefined;
    sessionId?: string | undefined;
    worktreeId: string;
    force: boolean;
    allowUnsupportedStop?: boolean | undefined;
    context: CommandHandlerContext;
  } & CleanupRuntime,
): Promise<void> {
  if (input.runId === undefined) {
    const error: SafeError = {
      tag: "HarnessProviderError",
      code: "HARNESS_RUN_MISSING",
      message: "The active harness run could not be resolved for cleanup.",
      provider: input.provider.id,
      worktreeId: input.worktreeId,
    };
    if (input.sessionId !== undefined) error.sessionId = input.sessionId;
    throw error;
  }
  if (input.provider.stop === undefined) {
    if (input.allowUnsupportedStop === true) {
      return;
    }
    const error: SafeError = {
      tag: "HarnessProviderError",
      code: "HARNESS_STOP_UNSUPPORTED",
      message: "The harness provider cannot stop runs.",
      provider: input.provider.id,
      worktreeId: input.worktreeId,
    };
    if (input.sessionId !== undefined) error.sessionId = input.sessionId;
    throw error;
  }
  const request = { runId: input.runId };
  const stopRequest: typeof request & { sessionId?: string; force?: boolean } = { ...request };
  if (input.sessionId !== undefined) stopRequest.sessionId = input.sessionId;
  if (input.force) stopRequest.force = true;
  await runProviderMutation(
    {
      operation: `provider.${input.provider.id}.stop`,
      clock: input.clock,
      commandTimeoutMs: input.commandTimeoutMs,
      signal: input.context.signal,
      trace: input.context.trace,
      fallback: {
        tag: "HarnessProviderError",
        code: "HARNESS_STOP_FAILED",
        message: "The harness provider failed to stop the run.",
        provider: input.provider.id,
      },
      timeoutFallback: {
        tag: "TimeoutError",
        code: "HARNESS_STOP_TIMEOUT",
        message: "The harness provider timed out while stopping the run.",
        provider: input.provider.id,
      },
    },
    () => input.provider.stop?.(stopRequest) as Promise<unknown>,
  );
}

function canUseTerminalCloseFallbackForSession(input: {
  session: SessionView;
  row?: WorktreeRow | undefined;
  force: boolean;
}): boolean {
  if (!input.force) {
    return false;
  }
  return hasCloseableTerminalAttachment({ session: input.session, row: input.row });
}

export function canUseTerminalCloseFallbackForWorktree(row: WorktreeRow, force: boolean): boolean {
  if (!force) {
    return false;
  }
  return hasCloseableTerminalAttachment({ row });
}

function terminalTargetMissing(error: unknown): boolean {
  const parsed = SafeErrorSchema.safeParse(error);
  return parsed.success && parsed.data.code === "TERMINAL_TARGET_MISSING";
}
