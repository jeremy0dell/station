import {
  type CommandId,
  type GetWorktreeRequest,
  type ProviderProjectConfig,
  type SafeError,
  type TraceContext,
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
import { assertCommandType } from "../assertCommand.js";
import {
  assertWorktreeRemovalAllowed,
  canUseTerminalCloseFallbackForWorktree,
  closeTerminalForWorktree,
  publishRemovedSessionIfAbsent,
  publishWorktreeRemoved,
  removeWorktreeThroughProvider,
  resolveWorktreeRemovalTarget,
  resolveWorktreeRowOrThrow,
  stopHarnessForWorktree,
} from "../cleanup/index.js";
import type { CommandHandler, CommandRecoveryHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { findProjectOrThrow, runProviderMutation, throwIfAborted } from "../session/shared.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";

export type CreateWorktreeRemoveHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  core: ObserverCore;
  persistence: EventJournal & SessionStore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Revalidates selected checkout and Git registration identity before coordinating removal.
 * Provider-confirmed removal cannot be overwritten by later cancellation or event-journal
 * degradation; it retries atomic session/title retirement once before publishing removal evidence.
 * A durable retirement failure authorizes only recovery replay of that idempotent completion path.
 */
export function createWorktreeRemoveHandler(
  options: CreateWorktreeRemoveHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "worktree.remove");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const snapshot = options.core.getSnapshot();
    const row = resolveWorktreeRowOrThrow(snapshot, payload.worktreeId, payload.projectId);
    const projectView = snapshot.projects.find((candidate) => candidate.id === row.projectId);
    const project = findProjectOrThrow(options.getProjects(), row.projectId);
    const stationSession = snapshot.sessions.find(
      (session) => session.origin === "station" && session.worktreeId === row.id,
    );
    const previousSessionId = stationSession?.id ?? row.agent?.sessionId;
    const force = payload.force === true;
    const currentWorktrees = await runProviderMutation(
      {
        operation: `provider.${options.providers.worktree.id}.listWorktrees.removeRevalidation`,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
        signal: context.signal,
        trace: context.trace,
        fallback: {
          tag: "WorktreeProviderError",
          code: "WORKTREE_REMOVE_REVALIDATION_FAILED",
          message: "Station could not refresh worktree evidence before removal.",
          provider: options.providers.worktree.id,
        },
      },
      async () => {
        if (options.providers.worktree.getWorktree === undefined) {
          return options.providers.worktree.listWorktrees(project);
        }
        const request: GetWorktreeRequest = {
          worktreeId: payload.worktreeId,
          projectId: row.projectId,
          path: payload.expectedPath,
          project,
          signal: context.signal,
        };
        const current = await options.providers.worktree.getWorktree(request);
        return current === null ? [] : [current];
      },
    );
    throwIfAborted(context.signal);
    const resolution = resolveWorktreeRemovalTarget({
      payload,
      snapshotRow: row,
      project,
      currentWorktrees,
    });
    if (!resolution.ok) {
      await options.logger?.warn("Worktree removal refused.", {
        commandId: context.commandId,
        traceId: context.trace.traceId,
        projectId: row.projectId,
        worktreeId: row.id,
        canonicalPath: resolution.canonicalPath,
        observedBranch: resolution.observedBranch,
        refusalReason: resolution.refusalReason,
      });
      throw resolution.error;
    }
    assertWorktreeRemovalAllowed(row, force, projectView, resolution.target);

    await stopHarnessForWorktree({
      providers: options.providers,
      row,
      force,
      allowUnsupportedStop: canUseTerminalCloseFallbackForWorktree(row, force),
      context,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    throwIfAborted(context.signal);
    await closeTerminalForWorktree({
      providers: options.providers,
      terminalIntentRunner: options.terminalIntentRunner,
      row,
      force,
      context,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    throwIfAborted(context.signal);
    try {
      await removeWorktreeThroughProvider({
        providers: options.providers,
        row,
        target: resolution.target,
        force,
        context,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
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
    let retirementError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.persistence.retireRemovedWorktreeSessionState({
          projectId: row.projectId,
          worktreeId: row.id,
          endedAt: nowIso(options.clock),
        });
        retirementError = undefined;
        break;
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError !== undefined) {
      await options.logger
        ?.error("Confirmed worktree removal retirement failed.", {
          commandId: context.commandId,
          traceId: context.trace.traceId,
          projectId: row.projectId,
          worktreeId: row.id,
          error: retirementError,
        })
        .catch(() => undefined);
      const error: SafeError = {
        tag: "PersistenceError",
        code: "WORKTREE_REMOVE_RETIREMENT_FAILED",
        message:
          "The worktree was removed, but Station could not retire its durable session state.",
        hint: "Do not retry deletion; inspect Observer persistence health before repairing session state.",
        projectId: row.projectId,
        worktreeId: row.id,
      };
      if (previousSessionId !== undefined) error.sessionId = previousSessionId;
      throw error;
    }

    let removalEventError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await publishRemovedSessionIfAbsent({
          previousSessionId,
          nextSessionIds: new Set(),
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
        removalEventError = undefined;
        break;
      } catch (error) {
        removalEventError = error;
      }
    }
    if (removalEventError !== undefined) {
      await options.logger
        ?.error("Confirmed worktree removal event publication failed.", {
          commandId: context.commandId,
          traceId: context.trace.traceId,
          projectId: row.projectId,
          worktreeId: row.id,
          error: removalEventError,
        })
        .catch(() => undefined);
    }
    scheduleRemovalReconcile({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      trace: context.trace,
      logger: options.logger,
      commandId: context.commandId,
      projectId: row.projectId,
      worktreeId: row.id,
    });
  };
}

function scheduleRemovalReconcile(input: {
  core: ObserverCore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
  commandId: CommandId;
  trace: TraceContext;
  projectId: string;
  worktreeId: string;
}): void {
  // Confirmed removal events must not wait behind the inventory repair they make necessary.
  void reconcileAndPublish({
    core: input.core,
    eventBus: input.eventBus,
    clock: input.clock,
    reason: "command:worktree.remove",
    trace: input.trace,
  }).catch((error: unknown) => {
    void input.logger
      ?.error("Deferred worktree removal convergence failed.", {
        commandId: input.commandId,
        traceId: input.trace.traceId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        error,
      })
      .catch(() => undefined);
  });
}

/** Recovers only provider-confirmed removal retirement; it never invokes external cleanup. */
export function createWorktreeRemoveRecoveryHandler(
  options: Pick<
    CreateWorktreeRemoveHandlerOptions,
    "core" | "persistence" | "eventBus" | "clock" | "logger"
  >,
): CommandRecoveryHandler {
  return async (context) => {
    if (
      context.command.type !== "worktree.remove" ||
      context.error.code !== "WORKTREE_REMOVE_RETIREMENT_FAILED" ||
      context.error.projectId === undefined ||
      (context.command.payload.projectId !== undefined &&
        context.error.projectId !== context.command.payload.projectId) ||
      context.error.worktreeId !== context.command.payload.worktreeId
    ) {
      return "ignored";
    }

    let retirementError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await options.persistence.retireRemovedWorktreeSessionState({
          projectId: context.error.projectId,
          worktreeId: context.command.payload.worktreeId,
          endedAt: nowIso(options.clock),
        });
        retirementError = undefined;
        break;
      } catch (error) {
        retirementError = error;
      }
    }
    if (retirementError !== undefined) {
      await options.logger
        ?.error("Confirmed worktree removal retirement recovery failed.", {
          commandId: context.commandId,
          traceId: context.trace.traceId,
          projectId: context.command.payload.projectId,
          worktreeId: context.command.payload.worktreeId,
          error: retirementError,
        })
        .catch(() => undefined);
      return "pending";
    }

    let removalEventError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await publishRemovedSessionIfAbsent({
          previousSessionId: context.error.sessionId,
          nextSessionIds: new Set(),
          persistence: options.persistence,
          eventBus: options.eventBus,
          context,
          clock: options.clock,
        });
        await publishWorktreeRemoved({
          worktreeId: context.command.payload.worktreeId,
          persistence: options.persistence,
          eventBus: options.eventBus,
          context,
          clock: options.clock,
        });
        removalEventError = undefined;
        break;
      } catch (error) {
        removalEventError = error;
      }
    }
    if (removalEventError !== undefined) {
      await options.logger
        ?.error("Recovered worktree removal event publication failed.", {
          commandId: context.commandId,
          traceId: context.trace.traceId,
          projectId: context.command.payload.projectId,
          worktreeId: context.command.payload.worktreeId,
          error: removalEventError,
        })
        .catch(() => undefined);
    }
    if (context.trigger === "replay") {
      scheduleRemovalReconcile({
        core: options.core,
        eventBus: options.eventBus,
        clock: options.clock,
        logger: options.logger,
        commandId: context.commandId,
        trace: context.trace,
        projectId: context.error.projectId,
        worktreeId: context.command.payload.worktreeId,
      });
    }
    return "recovered";
  };
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
