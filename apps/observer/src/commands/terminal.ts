import type { SafeError, StationSnapshot, TerminalClosePayload } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { nowIso } from "../utils/time.js";
import { assertCommandType } from "./assertCommand.js";
import { throwIfAborted } from "./cancellation.js";
import { publishRemovedSessionIfAbsent } from "./cleanup/events.js";
import {
  assertTerminalCloseAllowed,
  resolveRowForSession,
  resolveSessionOrThrow,
  resolveWorktreeRowOrThrow,
} from "./cleanup/index.js";
import type { CommandHandler } from "./queue.js";
import { reconcileAndPublish } from "./reconcile.js";
import type { TerminalIntentRunner } from "./terminalIntentRunner.js";
import {
  submitTerminalIntentOrThrow,
  terminalCloseIntentFromPayload,
  terminalFocusIntentFromPayload,
} from "./terminalIntents.js";

export type CreateTerminalFocusHandlerOptions = {
  core: ObserverCore;
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  commandTimeoutMs?: number | undefined;
};

export type CreateTerminalCloseHandlerOptions = {
  core: ObserverCore;
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  persistence?: (EventJournal & SessionStore) | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  commandTimeoutMs?: number | undefined;
};

export function createTerminalFocusHandler(
  options: CreateTerminalFocusHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "terminal.focus");
    throwIfAborted(context.signal);
    await submitTerminalIntentOrThrow({
      terminalIntentRunner: options.terminalIntentRunner,
      intent: terminalFocusIntentFromPayload({
        defaultTerminalId: options.providers.defaultTerminalId,
        commandId: context.commandId,
        payload: context.command.payload,
        snapshot: options.core.getSnapshot(),
      }),
      context,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    throwIfAborted(context.signal);
  };
}

export function createTerminalCloseHandler(
  options: CreateTerminalCloseHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "terminal.close");
    throwIfAborted(context.signal);
    const snapshot = options.core.getSnapshot();
    const resolved = resolveTerminalClosePolicySubject(snapshot, context.command.payload);
    assertTerminalCloseAllowed(
      resolved.row,
      resolved.session,
      context.command.payload.force === true,
    );
    throwIfAborted(context.signal);
    await submitTerminalIntentOrThrow({
      terminalIntentRunner: options.terminalIntentRunner,
      intent: terminalCloseIntentFromPayload({
        defaultTerminalId: options.providers.defaultTerminalId,
        commandId: context.commandId,
        payload: context.command.payload,
        snapshot,
      }),
      context,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    throwIfAborted(context.signal);
    if (resolved.session?.origin === "station" && options.persistence !== undefined) {
      await options.persistence.markSessionsEnded({
        subject: { kind: "session", sessionId: resolved.session.id },
        endedAt: nowIso(options.clock),
      });
    }

    const nextSnapshot = await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:terminal.close",
      trace: context.trace,
    });
    if (options.persistence !== undefined) {
      await publishRemovedSessionIfAbsent({
        previousSessionId: resolved.session?.id ?? resolved.row?.agent?.sessionId,
        nextSessionIds: new Set(nextSnapshot.sessions.map((session) => session.id)),
        persistence: options.persistence,
        eventBus: options.eventBus,
        context,
        clock: options.clock,
      });
    }
  };
}

function resolveTerminalClosePolicySubject(
  snapshot: StationSnapshot,
  payload: TerminalClosePayload,
) {
  if (payload.sessionId !== undefined) {
    const session = resolveSessionOrThrow(snapshot, payload.sessionId);
    return {
      session,
      row: resolveRowForSession(snapshot, session),
    };
  }
  if (payload.worktreeId === undefined) {
    throw terminalCloseSubjectMissingError();
  }
  const row = resolveWorktreeRowOrThrow(snapshot, payload.worktreeId);
  const session =
    row.agent?.sessionId === undefined
      ? snapshot.sessions.find(
          (candidate) =>
            candidate.origin === "station" &&
            candidate.worktreeId === row.id &&
            candidate.terminal !== undefined,
        )
      : snapshot.sessions.find(
          (candidate) => candidate.origin === "station" && candidate.id === row.agent?.sessionId,
        );
  return { row, session };
}

function terminalCloseSubjectMissingError(): SafeError {
  return {
    tag: "CommandValidationError",
    code: "TERMINAL_CLOSE_SUBJECT_MISSING",
    message: "terminal.close requires a session or worktree reference.",
  };
}
