import type { EventFilter, ObserverEventBusHealth, StationEvent } from "@station/contracts";
import { StationEventSchema, stationEventMetadata } from "@station/contracts";
import { Effect, Queue } from "@station/runtime";

const observerEventBusSubscriberCapacity = 1_024;

/** Future-only process-local delivery with bounded, independently disposable subscribers. */
export type ObserverEventBus = {
  publish(event: StationEvent): void;
  subscribe(filter?: EventFilter): AsyncIterable<StationEvent>;
  health(): ObserverEventBusHealth;
};

type Subscriber = {
  filter?: EventFilter;
  queue: Queue.Queue<StationEvent>;
  queuedEvents: number;
  active: boolean;
};

export function createObserverEventBus(
  options: { subscriberCapacity?: number } = {},
): ObserverEventBus {
  const subscriberCapacity = options.subscriberCapacity ?? observerEventBusSubscriberCapacity;
  const subscribers = new Set<Subscriber>();
  let queuedEvents = 0;
  let highWaterQueuedEvents = 0;
  let overflowCount = 0;
  let disconnectCount = 0;
  let resyncRequiredCount = 0;
  let lastOverflowReason: ObserverEventBusHealth["lastOverflowReason"];

  const health = (): ObserverEventBusHealth => {
    const result: ObserverEventBusHealth = {
      activeSubscribers: subscribers.size,
      queuedEvents,
      subscriberCapacity,
      highWaterQueuedEvents,
      overflowCount,
      disconnectCount,
      resyncRequiredCount,
    };
    if (lastOverflowReason !== undefined) result.lastOverflowReason = lastOverflowReason;
    return result;
  };
  const updateDepth = (subscriber: Subscriber) => {
    const nextDepth = Math.max(0, Effect.runSync(Queue.size(subscriber.queue)));
    queuedEvents += nextDepth - subscriber.queuedEvents;
    subscriber.queuedEvents = nextDepth;
    highWaterQueuedEvents = Math.max(highWaterQueuedEvents, queuedEvents);
  };
  const release = (subscriber: Subscriber) => {
    if (!subscriber.active) return;
    subscriber.active = false;
    subscribers.delete(subscriber);
    queuedEvents -= subscriber.queuedEvents;
    subscriber.queuedEvents = 0;
    Effect.runSync(Queue.takeAll(subscriber.queue));
    Effect.runSync(Queue.shutdown(subscriber.queue));
  };

  return {
    publish: (event) => {
      const parsedEvent = StationEventSchema.parse(event);
      for (const subscriber of subscribers) {
        if (subscriber.active && eventMatchesFilter(parsedEvent, subscriber.filter)) {
          const accepted = Effect.runSync(Queue.offer(subscriber.queue, parsedEvent));
          if (!accepted) {
            overflowCount += 1;
            disconnectCount += 1;
            resyncRequiredCount += 1;
            lastOverflowReason = "subscriber-capacity";
            release(subscriber);
            continue;
          }
          updateDepth(subscriber);
        }
      }
    },
    subscribe: (filter) =>
      effectQueueSubscription(subscribers, subscriberCapacity, updateDepth, release, filter),
    health,
  };
}

function effectQueueSubscription(
  subscribers: Set<Subscriber>,
  subscriberCapacity: number,
  updateDepth: (subscriber: Subscriber) => void,
  release: (subscriber: Subscriber) => void,
  filter?: EventFilter,
): AsyncIterable<StationEvent> {
  const subscriber: Subscriber = {
    ...(filter === undefined ? {} : { filter }),
    queue: Effect.runSync(Queue.dropping<StationEvent>(subscriberCapacity)),
    queuedEvents: 0,
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
        if (subscriber.active) updateDepth(subscriber);
        return subscriber.active ? { done: false, value: event } : { done: true, value: undefined };
      } catch {
        return { done: true, value: undefined };
      }
    },
    return: async () => {
      // Drain before shutdown so a caller retaining the iterator cannot retain event payloads.
      release(subscriber);
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
