import type { RuntimeClock } from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { assertCommandType } from "../assertCommand.js";
import {
  assertSessionCloseAllowed,
  assertWorktreeRemovalAllowed,
  canUseTerminalCloseFallbackForWorktree,
  closeSessionResources,
  closeTerminalForWorktree,
  publishRemovedSessionIfAbsent,
  publishWorktreeRemoved,
  removeWorktreeThroughProvider,
  resolveRowForSession,
  resolveSessionOrThrow,
  snapshotWorktreeMissingError,
  stopHarnessForWorktree,
} from "../cleanup/index.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { throwIfAborted } from "./shared.js";

export type CreateSessionRemoveHandlerOptions = {
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
};

export function createSessionRemoveHandler(
  options: CreateSessionRemoveHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "session.remove");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const snapshot = options.core.getSnapshot();
    const session = resolveSessionOrThrow(snapshot, payload.sessionId);
    const row = resolveRowForSession(snapshot, session);
    const project =
      row === undefined
        ? undefined
        : snapshot.projects.find((candidate) => candidate.id === row.projectId);
    assertSessionCloseAllowed(session, row, payload.force === true);
    if (payload.removeWorktree && row === undefined) {
      throw snapshotWorktreeMissingError(session.worktreeId, session.projectId);
    }
    if (payload.removeWorktree && row !== undefined) {
      assertWorktreeRemovalAllowed(row, payload.force === true, project);
    }

    if (payload.removeWorktree && row !== undefined) {
      await stopHarnessForWorktree({
        providers: options.providers,
        row,
        force: payload.force === true,
        allowUnsupportedStop: canUseTerminalCloseFallbackForWorktree(row, payload.force === true),
        context,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
      });
      throwIfAborted(context.signal);
      await closeTerminalForWorktree({
        providers: options.providers,
        row,
        force: payload.force === true,
        context,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
      });
      throwIfAborted(context.signal);
      await removeWorktreeThroughProvider({
        providers: options.providers,
        row,
        force: payload.force === true,
        context,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
      });
    } else {
      await closeSessionResources({
        providers: options.providers,
        session,
        row,
        mode: "all",
        force: payload.force === true,
        context,
        clock: options.clock,
        commandTimeoutMs: options.commandTimeoutMs,
      });
    }
    throwIfAborted(context.signal);

    const nextSnapshot = await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.remove",
      trace: context.trace,
    });
    await publishRemovedSessionIfAbsent({
      previousSessionId: session.id,
      nextSessionIds: new Set(nextSnapshot.sessions.map((candidate) => candidate.id)),
      persistence: options.persistence,
      eventBus: options.eventBus,
      context,
      clock: options.clock,
    });
    if (payload.removeWorktree && row !== undefined) {
      await publishWorktreeRemoved({
        worktreeId: row.id,
        persistence: options.persistence,
        eventBus: options.eventBus,
        context,
        clock: options.clock,
      });
    }
  };
}
