import type { RuntimeClock } from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { throwIfAborted } from "./shared.js";

export type CreateSessionRenameHandlerOptions = {
  core: ObserverCore;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

export function createSessionRenameHandler(
  options: CreateSessionRenameHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "session.rename");
    throwIfAborted(context.signal);

    const { sessionId } = context.command.payload;
    const title = context.command.payload.title.trim();
    if (title.length === 0) {
      throw {
        tag: "CommandValidationError",
        code: "SESSION_TITLE_REQUIRED",
        message: "Session title cannot be empty.",
        sessionId,
      };
    }

    const session = options.core
      .getSnapshot()
      .sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      throw sessionMissingError(sessionId);
    }

    const updated = await options.persistence.renameSession({ sessionId, title });
    if (updated === undefined) {
      throw sessionMissingError(sessionId);
    }

    throwIfAborted(context.signal);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.rename",
      trace: context.trace,
    });

    const event = {
      type: "session.updated" as const,
      sessionId,
      patch: { title },
    };
    await options.persistence.recordEvent(event, {
      commandId: context.commandId,
      traceId: context.trace.traceId,
      spanId: context.trace.spanId,
      createdAt: nowIso(options.clock),
    });
    options.eventBus?.publish(event);
  };
}

function sessionMissingError(sessionId: string) {
  return {
    tag: "CommandValidationError",
    code: "SESSION_NOT_FOUND",
    message: "No current session matches the requested session id.",
    hint: "Run station reconcile and retry with a current session id.",
    sessionId,
  };
}
