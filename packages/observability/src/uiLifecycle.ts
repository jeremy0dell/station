import type { LogRecord, UiLifecycleEvent } from "@station/contracts";
import { UiLifecycleEventSchema } from "@station/contracts";
import type { JsonlLogger } from "./logger.js";

type UiLifecycleComponent = UiLifecycleEvent["component"];
type UiLifecycleEventFor<Component extends UiLifecycleComponent> = Extract<
  UiLifecycleEvent,
  { component: Component }
>;
type UiLifecycleEventInputFor<Component extends UiLifecycleComponent> =
  UiLifecycleEventFor<Component> extends infer Event
    ? Event extends UiLifecycleEvent
      ? Omit<Event, "timestamp" | "component" | "eventId" | "source">
      : never
    : never;

type LogLevel = LogRecord["level"];

export type UiLifecycleRecorder<Component extends UiLifecycleComponent = UiLifecycleComponent> = {
  record(
    event: UiLifecycleEventInputFor<Component> & object,
    level: LogLevel,
  ): Promise<UiLifecycleEventFor<Component>>;
  flush(): Promise<void>;
};

/** Create source-ordered lifecycle records inside the component's normal JSONL log. */
export function createUiLifecycleRecorder<Component extends UiLifecycleComponent>(input: {
  logger: JsonlLogger;
  component: Component;
  sourceId: string;
  pid?: number;
  clock?: { now(): Date };
}): UiLifecycleRecorder<Component> {
  const clock = input.clock ?? { now: () => new Date() };
  const pid = input.pid ?? process.pid;
  let sequence = 0;

  return {
    async record(eventInput, level) {
      const currentSequence = sequence;
      sequence += 1;
      const timestamp = clock.now().toISOString();
      const eventFields: object = eventInput;
      const event = UiLifecycleEventSchema.parse({
        ...eventFields,
        timestamp,
        component: input.component,
        eventId: `${input.sourceId}:${currentSequence}`,
        source: { id: input.sourceId, sequence: currentSequence, pid },
      }) as UiLifecycleEventFor<Component>;
      await input.logger.log({
        timestamp,
        level,
        message: event.kind,
        lifecycle: event,
      });
      return event;
    },
    flush: () => input.logger.flush?.() ?? Promise.resolve(),
  };
}
