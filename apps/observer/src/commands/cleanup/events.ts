import type { RuntimeClock } from "@station/runtime";
import type { EventJournal } from "../../persistence/index.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import type { CommandHandlerContext } from "../queue.js";

type RemovalEventContext = Pick<CommandHandlerContext, "commandId" | "trace">;

/** Persists and publishes one command-correlated session removal at most once. */
export async function publishSessionRemoved(input: {
  sessionId: string;
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  context: RemovalEventContext;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  const recorded = await input.persistence.listEvents({
    commandId: input.context.commandId,
    type: "session.removed",
  });
  if (
    recorded.some(
      ({ event }) => event.type === "session.removed" && event.sessionId === input.sessionId,
    )
  ) {
    return;
  }
  const event = { type: "session.removed" as const, sessionId: input.sessionId };
  await input.persistence.recordEvent(event, {
    commandId: input.context.commandId,
    traceId: input.context.trace.traceId,
    spanId: input.context.trace.spanId,
    createdAt: nowIso(input.clock),
  });
  input.eventBus?.publish(event);
}

/** Persists and publishes one command-correlated worktree removal at most once. */
export async function publishWorktreeRemoved(input: {
  worktreeId: string;
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  context: RemovalEventContext;
  clock?: RuntimeClock | undefined;
}): Promise<void> {
  const recorded = await input.persistence.listEvents({
    commandId: input.context.commandId,
    type: "worktree.removed",
  });
  if (
    recorded.some(
      ({ event }) => event.type === "worktree.removed" && event.worktreeId === input.worktreeId,
    )
  ) {
    return;
  }
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
  persistence: EventJournal;
  eventBus?: ObserverEventBus | undefined;
  context: RemovalEventContext;
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
