import type { ProviderProjectConfig } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
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
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { findProjectOrThrow, runProviderMutation, throwIfAborted } from "../session/shared.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";

export type CreateWorktreeRemoveHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  core: ObserverCore;
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
  logger?: StationLogger | undefined;
};

/**
 * USE CASE
 *
 * Revalidates a selected checkout before coordinating terminal and worktree removal.
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
    const previousSessionId = row.agent?.sessionId;
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
      () => options.providers.worktree.listWorktrees(project),
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
    await removeWorktreeThroughProvider({
      providers: options.providers,
      row,
      target: resolution.target,
      force,
      context,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    throwIfAborted(context.signal);

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
  };
}
