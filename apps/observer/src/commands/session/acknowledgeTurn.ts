import type { ObserverPersistence } from "../../persistence/index.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { assertCommandType } from "../assertCommand.js";
import { resolveSessionOrThrow } from "../cleanup/index.js";
import type { CommandHandler } from "../queue.js";
import { throwIfAborted } from "./shared.js";

export type CreateSessionAcknowledgeTurnHandlerOptions = {
  core: ObserverCore;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
};

export function createSessionAcknowledgeTurnHandler(
  options: CreateSessionAcknowledgeTurnHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "session.acknowledgeTurn");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    resolveSessionOrThrow(options.core.getSnapshot(), payload.sessionId);
    await options.persistence.deleteSessionTurnReadiness({
      sessionId: payload.sessionId,
      token: payload.token,
    });
    throwIfAborted(context.signal);

    const event = options.core.clearTurnReadiness({
      sessionId: payload.sessionId,
      token: payload.token,
    });
    if (event !== undefined) {
      options.eventBus?.publish(event);
      await options.persistence.recordEvent(event, {
        source: "command",
        commandId: context.commandId,
        traceId: context.trace.traceId,
        spanId: context.trace.spanId,
      });
    }
  };
}
