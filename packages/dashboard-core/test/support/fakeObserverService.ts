import type {
  CommandReceipt,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import type { TuiCommandCompletion, TuiObserverService } from "@station/dashboard-core";

export class FakeTuiObserverService implements TuiObserverService {
  readonly dispatched: StationCommand[] = [];
  readonly events: StationEvent[] = [];
  readonly reconcileReasons: Array<string | undefined> = [];
  readonly waitedForCommandIds: string[] = [];
  cleanupCount = 0;
  loadCount = 0;
  subscribeCount = 0;
  nextReceipt: CommandReceipt = {
    commandId: "cmd_tui_1",
    accepted: true,
    status: "accepted",
  };
  nextCompletion: TuiCommandCompletion = {
    status: "succeeded",
    commandId: "cmd_tui_1",
  };

  private readonly subscribers = new Set<Subscriber>();

  constructor(private snapshot: StationSnapshot) {}

  async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    return this.snapshot;
  }

  subscribeEvents(): AsyncIterable<StationEvent> {
    this.subscribeCount += 1;
    const subscriber: Subscriber = {
      queue: [],
      waiters: [],
      active: true,
    };
    this.subscribers.add(subscriber);

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => nextEvent(subscriber),
        return: async () => {
          subscriber.active = false;
          this.subscribers.delete(subscriber);
          this.cleanupCount += 1;
          flushSubscriber(subscriber);
          return { done: true, value: undefined };
        },
      }),
    };
  }

  async dispatch(command: StationCommand): Promise<CommandReceipt> {
    this.dispatched.push(command);
    return this.nextReceipt;
  }

  async waitForCommandCompletion(commandId: string): Promise<TuiCommandCompletion> {
    this.waitedForCommandIds.push(commandId);
    return this.nextCompletion;
  }

  async reconcile(reason?: string): Promise<StationSnapshot> {
    this.reconcileReasons.push(reason);
    const command: StationCommand = {
      type: "observer.reconcile",
      payload: reason === undefined ? {} : { reason },
    };
    this.dispatched.push(command);
    return this.snapshot;
  }

  emit(event: StationEvent): void {
    this.events.push(event);
    for (const subscriber of this.subscribers) {
      if (!subscriber.active) continue;
      const waiter = subscriber.waiters.shift();
      if (waiter === undefined) {
        subscriber.queue.push(event);
      } else {
        waiter.resolve({ done: false, value: event });
      }
    }
  }

  setSnapshot(snapshot: StationSnapshot): void {
    this.snapshot = snapshot;
  }

  endSubscriptions(): void {
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      this.subscribers.delete(subscriber);
      flushSubscriber(subscriber);
    }
  }

  failSubscriptions(error: Error): void {
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      this.subscribers.delete(subscriber);
      rejectSubscriber(subscriber, error);
    }
  }
}

type Subscriber = {
  queue: StationEvent[];
  waiters: Array<{
    resolve(result: IteratorResult<StationEvent>): void;
    reject(error: Error): void;
  }>;
  active: boolean;
};

async function nextEvent(subscriber: Subscriber): Promise<IteratorResult<StationEvent>> {
  const event = subscriber.queue.shift();
  if (event !== undefined) {
    return { done: false, value: event };
  }
  if (!subscriber.active) {
    return { done: true, value: undefined };
  }
  return new Promise((resolve, reject) => {
    subscriber.waiters.push({
      resolve,
      reject,
    });
  });
}

function flushSubscriber(subscriber: Subscriber): void {
  for (;;) {
    const waiter = subscriber.waiters.shift();
    if (waiter === undefined) return;
    waiter.resolve({ done: true, value: undefined });
  }
}

function rejectSubscriber(subscriber: Subscriber, error: Error): void {
  for (;;) {
    const waiter = subscriber.waiters.shift();
    if (waiter === undefined) return;
    waiter.reject(error);
  }
}
