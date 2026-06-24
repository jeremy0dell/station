import type { RuntimeClock } from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import type { CommandHandlerContext } from "../queue.js";

export async function publishSessionRemoved(input: {
  sessionId: string;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  const event = { type: "session.removed" as const, sessionId: input.sessionId };
  await input.persistence.recordEvent(event, {
    commandId: input.context.commandId,
    traceId: input.context.trace.traceId,
    spanId: input.context.trace.spanId,
    createdAt: nowIso(input.clock),
  });
  input.eventBus?.publish(event);
}

export async function publishWorktreeRemoved(input: {
  worktreeId: string;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  const event = { type: "worktree.removed" as const, worktreeId: input.worktreeId };
  await input.persistence.recordEvent(event, {
    commandId: input.context.commandId,
    traceId: input.context.trace.traceId,
    spanId: input.context.trace.spanId,
    createdAt: nowIso(input.clock),
  });
  input.eventBus?.publish(event);
}

export async function publishRemovedSessionIfAbsent(input: {
  previousSessionId: string | undefined;
  nextSessionIds: ReadonlySet<string>;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  if (input.previousSessionId === undefined || input.nextSessionIds.has(input.previousSessionId)) {
    return;
  }
  await publishSessionRemoved({
    sessionId: input.previousSessionId,
    persistence: input.persistence,
    eventBus: input.eventBus,
    context: input.context,
    clock: input.clock,
  });
}
