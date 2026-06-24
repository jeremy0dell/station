import {
  createStationClientRuntime,
  type StationClientRefreshOutcome,
  type StationClientRuntime,
} from "@station/client";
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeferredLoadService,
  FakeObserverService,
  wrappedConnectError,
  wrappedSchemaMismatchError,
} from "../support/fakeObserverService.js";
import {
  createCommandSnapshot,
  createZeroWorktreeSnapshot,
  fixtureNow,
} from "../support/snapshots.js";

// Timing assertions use ratios and generous absolute bounds: jitter is ±20%
// and exponential doubling keeps consecutive jittered gaps from inverting, so
// only timer lateness adds noise, and lateness only widens later gaps.
describe("observer client runtime reconnect backoff", () => {
  const runtimes: StationClientRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
    }
  });

  function track(runtime: StationClientRuntime): StationClientRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  it("escalates reconnect delays across consecutive failures", async () => {
    const service = new AlwaysFailingService(createCommandSnapshot("idle"));
    const runtime = track(
      createStationClientRuntime({
        service,
        reconnect: { initialDelayMs: 10, maxDelayMs: 300 },
      }),
    );
    runtime.start();

    await waitFor(() => service.subscribeCount >= 6, 3_000);
    const gaps = subscribeGaps(service);
    const firstGap = gaps[0];
    const fifthGap = gaps[4];
    if (firstGap === undefined || fifthGap === undefined) {
      throw new Error("expected at least five reconnect gaps");
    }
    // Fixed-delay reconnects keep every gap equal; exponential growth makes
    // the fifth gap (~160ms jittered) dwarf the first (~10ms jittered).
    expect(fifthGap).toBeGreaterThan(firstGap * 2);
    expect(fifthGap).toBeGreaterThanOrEqual(100);
  });

  it("bounds reconnect delays at maxDelayMs", async () => {
    const service = new AlwaysFailingService(createCommandSnapshot("idle"));
    const runtime = track(
      createStationClientRuntime({
        service,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      }),
    );
    runtime.start();

    // Uncapped exponential growth from 5ms needs over four seconds of sleep
    // to reach ten reconnect gaps; the 20ms cap reaches them in under 200ms.
    await waitFor(() => service.subscribeCount >= 11, 2_500);
  });

  it("resets backoff after a successful resubscribe", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new ToggleFailingService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        reconnect: { initialDelayMs: 40, maxDelayMs: 5_000 },
      }),
    );
    runtime.start();

    await waitFor(() => service.subscribeCount >= 4, 3_000);
    const gaps = subscribeGaps(service);
    const escalatedGap = gaps[2];
    if (escalatedGap === undefined) {
      throw new Error("expected an escalated reconnect gap");
    }

    service.failing = false;
    await waitFor(() => service.waiterCount === 1, 3_000);
    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().connection.state === "connected", 3_000);

    const healthySubscribes = service.subscribeCount;
    const failedAt = Date.now();
    service.failing = true;
    service.failSubscriptions(wrappedConnectError());
    await waitFor(() => service.subscribeCount > healthySubscribes, 3_000);

    const lastSubscribeTime = service.subscribeTimes.at(-1);
    if (lastSubscribeTime === undefined) {
      throw new Error("expected a post-recovery subscribe attempt");
    }
    const postRecoveryGap = lastSubscribeTime - failedAt;
    // Without a reset the next delay would escalate past the pre-recovery gap
    // (~160ms jittered); a reset retries at the initial 40ms jittered delay.
    expect(postRecoveryGap).toBeLessThan(escalatedGap * 0.6);
    expect(postRecoveryGap).toBeLessThan(100);
  });
});

describe("observer client runtime refresh coalescing and shutdown", () => {
  const runtimes: StationClientRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
    }
  });

  function track(runtime: StationClientRuntime): StationClientRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  it("coalesces refresh-worthy events into one in-flight snapshot request plus one follow-up", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new DeferredLoadService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    service.emit(reconciledEvent());
    await waitFor(() => service.loadCount === 1);
    service.emit(reconciledEvent());
    service.emit(reconciledEvent());
    await delay(20);
    expect(service.loadCount).toBe(1);

    await waitFor(() => {
      service.releaseLoads();
      return !runtime.getState().inFlightRefresh;
    });
    expect(service.loadCount).toBe(2);
  });

  it("does not let a stale in-flight snapshot response stand after events applied during the flight", async () => {
    const stale = createCommandSnapshot("idle");
    const service = new DeferredLoadService(stale);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: stale,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    service.emit(reconciledEvent());
    await waitFor(() => service.loadCount === 1);
    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().snapshot?.rows[0]?.display.statusLabel === "working");

    // The pending flight resolves with the pre-event snapshot; the fresh
    // marker only becomes loadable afterwards.
    service.releaseLoads();
    service.setSnapshot(createZeroWorktreeSnapshot());
    await waitFor(() => {
      service.releaseLoads();
      return !runtime.getState().inFlightRefresh;
    });

    expect(runtime.getState().snapshot?.counts.worktrees).toBe(0);
    expect(service.loadCount).toBe(2);
  });

  it("stops without state changes, listener notifications, or hooks after stop() resolves", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new DeferredLoadService(snapshot);
    const outcomes: StationClientRefreshOutcome[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
        hooks: {
          onRefreshSettled: (outcome) => {
            outcomes.push(outcome);
          },
        },
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    service.emit(reconciledEvent());
    await waitFor(() => service.loadCount === 1);

    await runtime.stop();
    const frozen = runtime.getState();
    const outcomesAtStop = outcomes.length;
    let notified = 0;
    runtime.subscribe(() => {
      notified += 1;
    });

    service.releaseLoads();
    await delay(50);

    expect(runtime.getState()).toBe(frozen);
    expect(notified).toBe(0);
    expect(outcomes.length).toBe(outcomesAtStop);
  });
});

describe("observer client runtime resync-after-gap contract", () => {
  const runtimes: StationClientRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
    }
  });

  function track(runtime: StationClientRuntime): StationClientRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  it("withholds connected until a post-resubscribe resync refresh completes", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new DeferredLoadService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      }),
    );
    runtime.start();
    await waitFor(() => service.waiterCount === 1);
    expect(service.loadCount).toBe(0);

    // Kill the subscription: the gap begins and the runtime goes displayOnly.
    service.failSubscriptions(wrappedConnectError());
    await waitFor(() => runtime.getState().connection.state === "displayOnly");

    // The next cycle resubscribes and starts its resync, which hangs. Events
    // flow again and apply to the last good snapshot, but connected must be
    // withheld: events missed during the gap are undetectable until a full
    // reload lands.
    await waitFor(() => service.waiterCount === 1 && service.loadCount === 1);
    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().snapshot?.rows[0]?.display.statusLabel === "working");
    expect(runtime.getState().connection.state).toBe("displayOnly");

    // Completing the resync is what reports connected.
    service.releaseLoads();
    await waitFor(() => runtime.getState().connection.state === "connected");
    expect(service.loadCount).toBeGreaterThanOrEqual(1);
  });
});

class AlwaysFailingService extends FakeObserverService {
  override async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    throw wrappedConnectError();
  }

  override subscribeEvents(): AsyncIterable<StationEvent> {
    this.recordSubscribe();
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw wrappedConnectError();
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }
}

class ToggleFailingService extends FakeObserverService {
  failing = true;

  override async loadSnapshot(): Promise<StationSnapshot> {
    if (this.failing) {
      this.loadCount += 1;
      throw wrappedConnectError();
    }
    return super.loadSnapshot();
  }

  override subscribeEvents(): AsyncIterable<StationEvent> {
    if (!this.failing) {
      return super.subscribeEvents();
    }
    this.recordSubscribe();
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw wrappedConnectError();
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }
}

describe("observer client runtime permanent-error halt", () => {
  const runtimes: StationClientRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.stop();
    }
  });

  function track(runtime: StationClientRuntime): StationClientRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  it("halts permanently on schema mismatch, keeps the last snapshot, and stops resubscribing", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const infos: Array<{ isConnectError: boolean; alreadyReported: boolean; willRetry: boolean }> =
      [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
        hooks: {
          onSubscriptionError: (_error, info) => {
            infos.push(info);
          },
        },
      }),
    );
    runtime.start();
    await waitFor(() => service.waiterCount === 1);

    service.failSubscriptions(wrappedSchemaMismatchError());
    await waitFor(() => runtime.getState().connection.state === "halted");

    const connection = runtime.getState().connection;
    if (connection.state !== "halted") {
      throw new Error("expected a halted connection");
    }
    expect(connection.lastError.code).toBe("PROTOCOL_SCHEMA_MISMATCH");
    expect(runtime.getState().snapshot?.counts.worktrees).toBe(1);
    expect(infos).toEqual([{ isConnectError: false, alreadyReported: false, willRetry: false }]);

    // Halted means the runtime stops hitting the socket: no resubscribes
    // across several would-be backoff periods.
    const subscribes = service.subscribeCount;
    await delay(100);
    expect(service.subscribeCount).toBe(subscribes);
  });

  it("halts from loading when the initial resync reports a permanent error", async () => {
    const service = new FakeObserverService(createCommandSnapshot("idle"));
    service.loadSnapshot = async () => {
      throw wrappedSchemaMismatchError();
    };
    const outcomes: StationClientRefreshOutcome[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
        hooks: {
          onRefreshSettled: (outcome) => {
            outcomes.push(outcome);
          },
        },
      }),
    );
    runtime.start();

    await waitFor(() => runtime.getState().connection.state === "halted");
    expect(runtime.getState().snapshot).toBeUndefined();
    expect(outcomes.some((outcome) => outcome.status === "failure")).toBe(true);

    const subscribes = service.subscribeCount;
    await delay(100);
    expect(service.subscribeCount).toBe(subscribes);
  });
});

function subscribeGaps(service: FakeObserverService): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < service.subscribeTimes.length; index += 1) {
    const previous = service.subscribeTimes[index - 1];
    const current = service.subscribeTimes[index];
    if (previous !== undefined && current !== undefined) {
      gaps.push(current - previous);
    }
  }
  return gaps;
}

function reconciledEvent(): StationEvent {
  return { type: "observer.reconciled", at: fixtureNow, changed: 1 };
}

function rowUpdateEvent(): StationEvent {
  return {
    type: "worktree.updated",
    worktreeId: "wt_web_idle",
    patch: {
      display: {
        statusLabel: "working",
        sortPriority: 30,
        alert: false,
        reason: "Harness reported active generation.",
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await delay(5);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
