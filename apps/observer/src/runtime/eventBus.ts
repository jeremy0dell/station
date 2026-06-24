import type { EventFilter, StationEvent } from "@station/contracts";
import { StationEventSchema, stationEventMetadata } from "@station/contracts";
import { Effect, Queue } from "@station/runtime";

export type ObserverEventBus = {
  publish(event: StationEvent): void;
  subscribe(filter?: EventFilter): AsyncIterable<StationEvent>;
};

type Subscriber = {
  filter?: EventFilter;
  queue: Queue.Queue<StationEvent>;
  active: boolean;
};

export function createObserverEventBus(): ObserverEventBus {
  const subscribers = new Set<Subscriber>();

  return {
    publish: (event) => {
      const parsedEvent = StationEventSchema.parse(event);
      for (const subscriber of subscribers) {
        if (subscriber.active && eventMatchesFilter(parsedEvent, subscriber.filter)) {
          Effect.runSync(Queue.offer(subscriber.queue, parsedEvent));
        }
      }
    },
    subscribe: (filter) => effectQueueSubscription(subscribers, filter),
  };
}

function effectQueueSubscription(
  subscribers: Set<Subscriber>,
  filter?: EventFilter,
): AsyncIterable<StationEvent> {
  const subscriber: Subscriber = {
    ...(filter === undefined ? {} : { filter }),
    queue: Effect.runSync(Queue.unbounded<StationEvent>()),
    active: true,
  };
  subscribers.add(subscriber);

  const iterator: AsyncIterator<StationEvent> = {
    next: async () => {
      if (!subscriber.active) {
        return { done: true, value: undefined };
      }
      try {
        const event = await Effect.runPromise(Queue.take(subscriber.queue));
        return subscriber.active ? { done: false, value: event } : { done: true, value: undefined };
      } catch {
        return { done: true, value: undefined };
      }
    },
    return: async () => {
      // Remove the subscriber and shut down its queue so pending takes unblock.
      subscriber.active = false;
      subscribers.delete(subscriber);
      await Effect.runPromise(Queue.shutdown(subscriber.queue));
      return { done: true, value: undefined };
    },
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

function eventMatchesFilter(event: StationEvent, filter: EventFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }

  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) {
      return false;
    }
  }

  if (
    filter.commandId !== undefined ||
    filter.traceId !== undefined ||
    filter.since !== undefined
  ) {
    const metadata = stationEventMetadata(event);

    if (filter.commandId !== undefined && metadata.commandId !== filter.commandId) {
      return false;
    }
    if (filter.traceId !== undefined && metadata.traceId !== filter.traceId) {
      return false;
    }
    if (filter.since !== undefined && metadata.timestamp !== undefined) {
      return Date.parse(metadata.timestamp) >= Date.parse(filter.since);
    }
  }

  return true;
}
