import type { RuntimeClock } from "@station/runtime";
import type { EventJournal } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { assertCommandType } from "../assertCommand.js";
import {
  assertWorktreeRemovalAllowed,
  canUseTerminalCloseFallbackForWorktree,
  closeTerminalForWorktree,
  publishRemovedSessionIfAbsent,
  publishWorktreeRemoved,
  removeWorktreeThroughProvider,
  resolveWorktreeRowOrThrow,
  stopHarnessForWorktree,
} from "../cleanup/index.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { throwIfAborted } from "../session/shared.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";

export type CreateWorktreeRemoveHandlerOptions = {
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  core: ObserverCore;
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
};

export function createWorktreeRemoveHandler(
  options: CreateWorktreeRemoveHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "worktree.remove");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const snapshot = options.core.getSnapshot();
    const row = resolveWorktreeRowOrThrow(snapshot, payload.worktreeId, payload.projectId);
    const project = snapshot.projects.find((candidate) => candidate.id === row.projectId);
    const previousSessionId = row.agent?.sessionId;
    const force = payload.force === true;
    assertWorktreeRemovalAllowed(row, force, project);

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
