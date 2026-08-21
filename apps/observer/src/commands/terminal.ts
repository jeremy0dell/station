import type {
  SafeError,
  StationSnapshot,
  TerminalClosePayload,
  TerminalFocusPayload,
} from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import type { StationLogger } from "../stationLogger.js";
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
import { resolveTerminalProviderOrThrow } from "./providers.js";
import type { CommandHandler } from "./queue.js";
import { reconcileAndPublish } from "./reconcile.js";
import {
  closeTerminal,
  focusTerminal,
  type TerminalTargetSubject,
  terminalTargetSubjectForSession,
  terminalTargetSubjectForWorktree,
} from "./terminalOperations.js";

export type CreateTerminalFocusHandlerOptions = {
  core: ObserverCore;
  providers: ProviderRegistry;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
};

export type CreateTerminalCloseHandlerOptions = {
  core: ObserverCore;
  providers: ProviderRegistry;
  persistence?: (EventJournal & SessionStore) | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

export function createTerminalFocusHandler(
  options: CreateTerminalFocusHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "terminal.focus");
    throwIfAborted(context.signal);
    const resolved = resolveTerminalFocusSubject(
      options.core.getSnapshot(),
      context.command.payload,
      options.providers.defaultTerminalId,
    );
    await focusTerminal({
      terminal: resolveTerminalProviderOrThrow(options.providers, resolved.terminalProvider),
      subject: resolved.subject,
      origin: context.command.payload.origin,
      context,
      clock: options.clock,
      logger: options.logger,
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
    const terminalProvider =
      resolved.session?.terminal?.provider ??
      resolved.row?.terminal?.provider ??
      options.providers.defaultTerminalId;
    let subject: TerminalTargetSubject;
    if (resolved.session !== undefined) {
      subject = terminalTargetSubjectForSession(resolved.session, resolved.row);
    } else {
      if (resolved.row === undefined) throw terminalCloseSubjectMissingError();
      subject = terminalTargetSubjectForWorktree(resolved.row);
    }
    await closeTerminal({
      terminal: resolveTerminalProviderOrThrow(options.providers, terminalProvider),
      subject,
      context,
      clock: options.clock,
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

function resolveTerminalFocusSubject(
  snapshot: StationSnapshot,
  payload: TerminalFocusPayload,
  fallbackProvider: string,
): { terminalProvider: string; subject: TerminalTargetSubject } {
  if (payload.sessionId !== undefined) {
    const session = snapshot.sessions.find((candidate) => candidate.id === payload.sessionId);
    if (session !== undefined) {
      const row = resolveRowForSession(snapshot, session);
      return {
        terminalProvider: session.terminal?.provider ?? row?.terminal?.provider ?? fallbackProvider,
        subject: terminalTargetSubjectForSession(session, row),
      };
    }
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    return {
      terminalProvider: row?.terminal?.provider ?? fallbackProvider,
      subject: {
        sessionId: payload.sessionId,
        ...(payload.worktreeId === undefined ? {} : { worktreeId: payload.worktreeId }),
      },
    };
  }
  if (payload.worktreeId !== undefined) {
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    return {
      terminalProvider: row?.terminal?.provider ?? fallbackProvider,
      subject:
        row === undefined
          ? { worktreeId: payload.worktreeId }
          : terminalTargetSubjectForWorktree(row),
    };
  }
  throw terminalFocusSubjectMissingError();
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

function terminalFocusSubjectMissingError(): SafeError {
  return {
    tag: "CommandValidationError",
    code: "TERMINAL_INTENT_SUBJECT_MISSING",
    message: "Terminal commands require a session or worktree reference.",
  };
}
