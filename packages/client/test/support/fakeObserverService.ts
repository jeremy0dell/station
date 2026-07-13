import type {
  HarnessReadinessQueryParams,
  HarnessReadinessQueryResult,
  ObserverService,
  StationClientCommandCompletion,
} from "@station/client";
import type {
  CommandReceipt,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";

export class FakeObserverService implements ObserverService {
  readonly dispatched: StationCommand[] = [];
  readonly events: StationEvent[] = [];
  readonly reconcileReasons: Array<string | undefined> = [];
  readonly readinessQueries: HarnessReadinessQueryParams[] = [];
  readonly subscribeTimes: number[] = [];
  readonly waitedForCommandIds: string[] = [];
  cleanupCount = 0;
  loadCount = 0;
  subscribeCount = 0;
  nextReceipt: CommandReceipt = {
    commandId: "cmd_client_1",
    accepted: true,
    status: "accepted",
  };
  nextCompletion: StationClientCommandCompletion = {
    status: "succeeded",
    commandId: "cmd_client_1",
  };

  private readonly subscribers = new Set<Subscriber>();

  constructor(protected snapshot: StationSnapshot) {}

  async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    return this.snapshot;
  }

  subscribeEvents(): AsyncIterable<StationEvent> {
    this.recordSubscribe();
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

  async waitForCommandCompletion(commandId: string): Promise<StationClientCommandCompletion> {
    this.waitedForCommandIds.push(commandId);
    return this.nextCompletion;
  }

  async reconcile(reason?: string): Promise<StationSnapshot> {
    this.reconcileReasons.push(reason);
    return this.snapshot;
  }

  async getHarnessReadiness(
    params: HarnessReadinessQueryParams,
  ): Promise<HarnessReadinessQueryResult> {
    this.readinessQueries.push(params);
    return fakeHarnessReadiness(params.provider);
  }

  // Subclasses that replace subscribeEvents call this so reconnect-timing
  // tests can read subscribeTimes regardless of the subscription's fate.
  protected recordSubscribe(): void {
    this.subscribeCount += 1;
    this.subscribeTimes.push(Date.now());
  }

  // True only while the consumer is parked on iterator.next(); tests gate
  // failSubscriptions on this so the rejection cannot race event handling and
  // degrade into a clean end.
  get waiterCount(): number {
    let count = 0;
    for (const subscriber of this.subscribers) {
      count += subscriber.waiters.length;
    }
    return count;
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

function fakeHarnessReadiness(provider: string): HarnessReadinessQueryResult {
  return {
    readiness: {
      provider,
      label: provider,
      kind: "built_in",
      configuration: "configured",
      cli: "available",
      authentication: "ready",
      launchability: "ready",
      trackingSetup: "prepared",
      tracking: "prepared_unverified",
      freshness: "fresh",
      decision: "launch_ready",
      revision: "fake-readiness-revision",
      explanation: `${provider} is prepared for Station.`,
      actions: ["use", "technical_details"],
      technicalDetails: [],
    },
  };
}

export class DeferredLoadService extends FakeObserverService {
  private readonly pendingLoads: Array<(snapshot: StationSnapshot) => void> = [];

  override async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    return new Promise((resolve) => {
      this.pendingLoads.push(resolve);
    });
  }

  releaseLoads(): void {
    for (const resolve of this.pendingLoads.splice(0)) {
      resolve(this.snapshot);
    }
  }
}

function connectSafeError(): { tag: string; code: string; message: string } {
  return {
    tag: "ProtocolError",
    code: "PROTOCOL_CONNECT_FAILED",
    message: "Could not connect to the observer socket.",
  };
}

export function wrappedConnectError(): Error {
  const error = new Error("wrapped connect failure");
  (error as Error & { cause?: unknown }).cause = connectSafeError();
  return error;
}

function schemaMismatchSafeError(): { tag: string; code: string; message: string } {
  return {
    tag: "ProtocolError",
    code: "PROTOCOL_SCHEMA_MISMATCH",
    message: "The observer is running an incompatible snapshot schema.",
  };
}

export function wrappedSchemaMismatchError(): Error {
  const error = new Error("wrapped schema mismatch");
  (error as Error & { cause?: unknown }).cause = schemaMismatchSafeError();
  return error;
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
