import type {
  CommandReceipt,
  HarnessReadinessQueryParams,
  HarnessReadinessQueryResult,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import type {
  AgentPrepareExternalLaunchParams,
  AgentPrepareExternalLaunchResult,
  AgentReportExternalExitParams,
  AgentReportExternalExitResult,
} from "@station/client";
import type { TuiCommandCompletion, TuiObserverService } from "@station/dashboard-core";

export class FakeTuiObserverService implements TuiObserverService {
  readonly dispatched: StationCommand[] = [];
  readonly events: StationEvent[] = [];
  readonly reconcileReasons: Array<string | undefined> = [];
  readonly readinessQueries: HarnessReadinessQueryParams[] = [];
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
  /** Thrown (once) by the next reconcile call instead of returning a snapshot. */
  nextReconcileError: unknown = undefined;

  private readonly subscribers = new Set<Subscriber>();
  private loadGate: { promise: Promise<void>; release(): void } | undefined;

  constructor(private snapshot: StationSnapshot) {}

  async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    await this.loadGate?.promise;
    return this.snapshot;
  }

  /** Parks subsequent loadSnapshot calls until resumeLoadSnapshot. */
  pauseLoadSnapshot(): void {
    if (this.loadGate !== undefined) {
      return;
    }
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.loadGate = { promise, release };
  }

  resumeLoadSnapshot(): void {
    this.loadGate?.release();
    this.loadGate = undefined;
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
    if (this.nextReconcileError !== undefined) {
      const error = this.nextReconcileError;
      this.nextReconcileError = undefined;
      throw error;
    }
    const command: StationCommand = {
      type: "observer.reconcile",
      payload: reason === undefined ? {} : { reason },
    };
    this.dispatched.push(command);
    return this.snapshot;
  }

  async getHarnessReadiness(
    params: HarnessReadinessQueryParams,
  ): Promise<HarnessReadinessQueryResult> {
    this.readinessQueries.push(params);
    return fakeHarnessReadiness(params.provider);
  }

  readonly preparedLaunches: AgentPrepareExternalLaunchParams[] = [];
  readonly reportedExits: string[] = [];
  nextPreparedLaunch: AgentPrepareExternalLaunchResult = {
    kind: "existing-session",
    sessionId: "ses_fake",
    harnessProvider: "codex",
  };

  async prepareExternalLaunch(
    params: AgentPrepareExternalLaunchParams,
  ): Promise<AgentPrepareExternalLaunchResult> {
    this.preparedLaunches.push(params);
    return this.nextPreparedLaunch;
  }

  async reportExternalExit(
    params: AgentReportExternalExitParams,
  ): Promise<AgentReportExternalExitResult> {
    this.reportedExits.push(params.terminalTargetId);
    return { acknowledged: true, terminalTargetId: params.terminalTargetId };
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
