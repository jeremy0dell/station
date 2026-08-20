import {
  type ProviderProjectConfig,
  type SafeError,
  type WorktreeRemovalRefusalDiagnosticDetail,
  WorktreeRemovalRefusalDiagnosticDetailSchema,
} from "@station/contracts";
import { isSafeError, type RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { nowIso } from "../../utils/time.js";
import type { WorktreeMutationCoordinator } from "../../worktreeMutationCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import {
  canUseTerminalCloseFallbackForWorktree,
  closeTerminalForWorktree,
  publishRemovedSessionIfAbsent,
  publishWorktreeRemoved,
  removeWorktreeThroughProvider,
  resolveWorktreeRowOrThrow,
  stopHarnessForWorktree,
} from "../cleanup/index.js";
import type { CommandHandler, CommandHandlerContext } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { throwIfAborted } from "../session/shared.js";
import {
  refreshReservedWorktreeRemoval,
  validateWorktreeRemoval,
  type WorktreeRemovalValidation,
} from "./removalValidation.js";

export type CreateWorktreeRemoveHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: EventJournal & SessionStore;
  worktreeMutations: WorktreeMutationCoordinator;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Revalidates selected checkout and Git registration identity before coordinating removal.
 * A renderer reservation holds the same worktree mutation slot while external PTYs settle;
 * provider-confirmed removal then atomically ends sessions and retires canonical title authority.
 */
export function createWorktreeRemoveHandler(
  options: CreateWorktreeRemoveHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "worktree.remove");
    throwIfAborted(context.signal);
    const payload = context.command.payload;
    const reservationId = payload.removalReservationId;

    if (reservationId !== undefined) {
      if (payload.projectId === undefined) {
        throw invalidReservedProjectError(payload.worktreeId);
      }
      await options.worktreeMutations.consume<WorktreeRemovalValidation, void>(
        reservationId,
        payload.projectId,
        payload.worktreeId,
        async (prepared) => {
          const validation = refreshReservedWorktreeRemoval(options, payload, prepared);
          await removeValidatedWorktree(options, context, validation);
        },
      );
      return;
    }

    const row = resolveWorktreeRowOrThrow(
      options.core.getSnapshot(),
      payload.worktreeId,
      payload.projectId,
    );
    await options.worktreeMutations.runUnreserved(row.projectId, row.id, async () => {
      const validation = await validateWorktreeRemoval(options, payload, {
        signal: context.signal,
        trace: context.trace,
        commandId: context.commandId,
      });
      await removeValidatedWorktree(options, context, validation);
    });
  };
}

async function removeValidatedWorktree(
  options: CreateWorktreeRemoveHandlerOptions,
  context: CommandHandlerContext,
  validation: WorktreeRemovalValidation,
): Promise<void> {
  const { row, project, target, previousSessionId, force } = validation;
  if (validation.externalTerminalExitRequired) {
    throw externalTerminalExitRequiredError(row.projectId, row.id);
  }
  await stopHarnessForWorktree({
    providers: options.providers,
    row,
    force,
    allowUnsupportedStop: canUseTerminalCloseFallbackForWorktree(row, force),
    context,
    clock: options.clock,
  });
  throwIfAborted(context.signal);
  await closeTerminalForWorktree({
    providers: options.providers,
    row,
    force,
    context,
    clock: options.clock,
  });
  throwIfAborted(context.signal);
  try {
    await removeWorktreeThroughProvider({
      providers: options.providers,
      project,
      row,
      target,
      force,
      context,
      clock: options.clock,
    });
  } catch (error) {
    const refusal = worktreeRemovalRefusalDiagnostic(error);
    if (refusal !== undefined) {
      await options.logger?.warn("Worktree removal refused during final provider validation.", {
        commandId: context.commandId,
        traceId: context.trace.traceId,
        projectId: refusal.projectId ?? row.projectId,
        worktreeId: refusal.worktreeId,
        canonicalPath: refusal.canonicalPath,
        observedBranch: refusal.observedBranch,
        refusalReason: refusal.refusalReason,
        provider: refusal.provider ?? options.providers.worktree.id,
      });
    }
    throw error;
  }
  throwIfAborted(context.signal);
  await options.persistence.retireRemovedWorktreeSessionState({
    projectId: row.projectId,
    worktreeId: row.id,
    endedAt: nowIso(options.clock),
  });

  const nextSnapshot = await reconcileAndPublish({
    core: options.core,
    eventBus: options.eventBus,
    clock: options.clock,
    reason: "command:worktree.remove",
    trace: context.trace,
  });
  await publishRemovedSessionIfAbsent({
    previousSessionId,
    nextSessionIds: new Set(nextSnapshot.sessions.map((session) => session.id)),
    persistence: options.persistence,
    eventBus: options.eventBus,
    context,
    clock: options.clock,
  });
  await publishWorktreeRemoved({
    worktreeId: row.id,
    persistence: options.persistence,
    eventBus: options.eventBus,
    context,
    clock: options.clock,
  });
}

function worktreeRemovalRefusalDiagnostic(
  error: unknown,
): WorktreeRemovalRefusalDiagnosticDetail | undefined {
  if (!isSafeError(error)) {
    return undefined;
  }
  for (const detail of error.diagnosticDetails ?? []) {
    const parsed = WorktreeRemovalRefusalDiagnosticDetailSchema.safeParse(detail);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

function externalTerminalExitRequiredError(projectId: string, worktreeId: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "EXTERNAL_TERMINAL_EXIT_REQUIRED",
    message: "The worktree still has a terminal owned by an external Station renderer.",
    hint: "Close that terminal from native Station and retry removal.",
    projectId,
    worktreeId,
  };
}

function invalidReservedProjectError(worktreeId: string) {
  return {
    tag: "CommandValidationError" as const,
    code: "WORKTREE_REMOVAL_RESERVATION_INVALID",
    message: "Reserved worktree removal requires the validated project identity.",
    hint: "Refresh the dashboard and confirm removal again.",
    worktreeId,
  };
}
