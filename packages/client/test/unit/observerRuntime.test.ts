import {
  type ApplyStationEventResult,
  createStationClientRuntime,
  executeObserverCommand,
  type StationClientRefreshOutcome,
  type StationClientRuntime,
} from "@station/client";
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeferredLoadService,
  FakeObserverService,
  wrappedConnectError,
} from "../support/fakeObserverService.js";
import {
  createCommandSnapshot,
  createZeroWorktreeSnapshot,
  fixtureNow,
  sessionGroup,
} from "../support/snapshots.js";

const RECONNECT_OPTIONS = { initialDelayMs: 5, maxDelayMs: 20 } as const;

describe("observer client runtime", () => {
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

  it("loads the initial snapshot and transitions idle -> loading -> connected", async () => {
    const service = new FakeObserverService(createCommandSnapshot("idle"));
    const runtime = track(createStationClientRuntime({ service, reconnect: RECONNECT_OPTIONS }));

    expect(runtime.getState().connection.state).toBe("idle");
    runtime.start();
    expect(runtime.getState().connection.state).toBe("loading");

    await waitFor(() => runtime.getState().connection.state === "connected");
    expect(runtime.getState().snapshot?.counts.worktrees).toBe(1);
    expect(service.loadCount).toBe(1);
  });

  it("returns reference-stable state between changes and a new object per change", async () => {
    const service = new FakeObserverService(createCommandSnapshot("idle"));
    const runtime = track(createStationClientRuntime({ service, reconnect: RECONNECT_OPTIONS }));
    runtime.start();
    await waitFor(() => runtime.getState().connection.state === "connected");

    const before = runtime.getState();
    expect(runtime.getState()).toBe(before);

    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState() !== before);
    expect(runtime.getState().snapshot?.rows[0]?.display.statusLabel).toBe("working");
    expect(before.snapshot?.rows[0]?.display.statusLabel).toBe("idle");
  });

  it("converges event-only Group create, rename, membership, and removal", async () => {
    const initial = createCommandSnapshot("idle");
    const memberId = initial.sessions[0]?.id;
    if (memberId === undefined) throw new Error("Expected an idle fixture session.");
    const service = new FakeObserverService(initial);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: initial,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    const created = sessionGroup({ sessionIds: [memberId] });
    service.setSnapshot({ ...initial, sessionGroups: [created] });
    service.emit(groupUpdatedEvent(created));
    await waitFor(() => runtime.getState().snapshot?.sessionGroups.length === 1);
    expect(runtime.getState().snapshot?.sessionGroups).toEqual([created]);
    expect(service.loadCount).toBe(1);

    const renamed = sessionGroup({
      name: "Renamed work",
      sessionIds: [memberId],
      version: 2,
      updatedAt: "2026-05-20T12:01:00.000Z",
    });
    service.emit(groupUpdatedEvent(renamed));
    await waitFor(() => runtime.getState().snapshot?.sessionGroups[0]?.version === 2);
    expect(runtime.getState().snapshot?.sessionGroups).toEqual([renamed]);
    expect(service.loadCount).toBe(1);

    const membership = sessionGroup({
      name: "Renamed work",
      version: 3,
      updatedAt: "2026-05-20T12:02:00.000Z",
    });
    service.setSnapshot({ ...initial, sessionGroups: [membership] });
    service.emit(groupUpdatedEvent(membership));
    await waitFor(() => runtime.getState().snapshot?.sessionGroups[0]?.version === 3);
    expect(runtime.getState().snapshot?.sessionGroups).toEqual([membership]);
    expect(service.loadCount).toBe(2);

    service.emit({
      type: "sessionGroup.removed",
      at: fixtureNow,
      commandId: "cmd_group_removed",
      projectId: "web",
      groupId: membership.id,
    });
    await waitFor(() => runtime.getState().snapshot?.sessionGroups.length === 0);
    expect(runtime.getState().snapshot?.sessionGroups).toEqual([]);
    expect(service.loadCount).toBe(2);
  });

  it("notifies subscribers on changes and stops after unsubscribe", async () => {
    const service = new FakeObserverService(createCommandSnapshot("idle"));
    const runtime = track(createStationClientRuntime({ service, reconnect: RECONNECT_OPTIONS }));
    runtime.start();
    await waitFor(() => runtime.getState().connection.state === "connected");

    let notified = 0;
    const unsubscribe = runtime.subscribe(() => {
      notified += 1;
    });
    service.emit(rowUpdateEvent());
    await waitFor(() => notified > 0);

    const seen = notified;
    unsubscribe();
    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().snapshot !== undefined);
    expect(notified).toBe(seen);
  });

  it("drops events that arrive before the first snapshot without leaving loading", async () => {
    const service = new DeferredLoadService(createCommandSnapshot("idle"));
    const applications: Array<ApplyStationEventResult | undefined> = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        reconnect: RECONNECT_OPTIONS,
        hooks: {
          onEvent: (_event, application) => {
            applications.push(application);
          },
        },
      }),
    );
    runtime.start();

    await waitFor(() => service.subscribeCount === 1);
    service.emit(rowUpdateEvent());
    await waitFor(() => applications.length === 1);

    expect(applications[0]).toBeUndefined();
    expect(runtime.getState().connection.state).toBe("loading");
    expect(runtime.getState().snapshot).toBeUndefined();

    service.releaseLoads();
    await waitFor(() => runtime.getState().snapshot !== undefined);
    expect(runtime.getState().connection.state).toBe("connected");
  });

  it("refreshes and resubscribes after a clean subscription end without leaving connected", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);
    expect(service.loadCount).toBe(0);

    service.setSnapshot(createZeroWorktreeSnapshot());
    service.endSubscriptions();

    await waitFor(() => service.subscribeCount === 2);
    await waitFor(() => runtime.getState().snapshot?.counts.worktrees === 0);
    expect(runtime.getState().connection.state).toBe("connected");
    expect(service.loadCount).toBe(1);
  });

  it("replaces a ghost Group after a subscription gap", async () => {
    const canonical = createCommandSnapshot("idle");
    const ghost = {
      ...canonical,
      sessionGroups: [sessionGroup({ id: "grp_ghost", name: "Ghost" })],
    };
    const service = new FakeObserverService(canonical);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: ghost,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    service.endSubscriptions();

    await waitFor(() => service.subscribeCount === 2);
    await waitFor(() => runtime.getState().snapshot?.sessionGroups.length === 0);
    expect(runtime.getState().snapshot).toBe(canonical);
  });

  it("marks connect-classified subscription failures displayOnly and preserves since", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new ConnectFailingService(snapshot);
    const subscriptionErrors: Array<{ isConnectError: boolean }> = [];
    const connectFailures: number[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
        hooks: {
          onSubscriptionError: (_error, info) => {
            subscriptionErrors.push(info);
          },
          onRefreshSettled: (outcome) => {
            if (outcome.status === "connectFailure") {
              connectFailures.push(Date.now());
            }
          },
        },
      }),
    );
    runtime.start();

    await waitFor(() => service.waiterCount === 1);
    service.failSubscriptions(wrappedConnectError());
    await waitFor(() => runtime.getState().connection.state === "displayOnly");
    const first = runtime.getState().connection;

    // Later cycles resubscribe but fail their resync loads with connect
    // errors, re-entering displayOnly without resetting the downtime origin.
    await waitFor(() => connectFailures.length >= 2 && service.subscribeCount >= 3);

    const second = runtime.getState().connection;
    expect(second.state).toBe("displayOnly");
    expect(second.state === "displayOnly" && first.state === "displayOnly").toBe(true);
    if (second.state === "displayOnly" && first.state === "displayOnly") {
      expect(second.since).toBe(first.since);
    }
    expect(runtime.getState().snapshot?.counts.worktrees).toBe(1);
    expect(subscriptionErrors.length).toBeGreaterThanOrEqual(1);
    expect(subscriptionErrors.every((info) => info.isConnectError)).toBe(true);
  });

  it("marks cold-start connect failures reconnecting without a snapshot", async () => {
    const service = new ColdStartConnectFailingService(createCommandSnapshot("idle"));
    const runtime = track(createStationClientRuntime({ service, reconnect: RECONNECT_OPTIONS }));
    runtime.start();

    await waitFor(() => runtime.getState().connection.state === "reconnecting");
    expect(runtime.getState().snapshot).toBeUndefined();
  });

  it("reports non-connect subscription failures once until an event resets the dedup flag", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const reports: boolean[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
        hooks: {
          onSubscriptionError: (_error, info) => {
            reports.push(info.alreadyReported);
          },
        },
      }),
    );
    runtime.start();

    await waitFor(() => service.waiterCount === 1);
    service.failSubscriptions(new Error("subscription exploded"));
    await waitFor(() => service.subscribeCount >= 2 && service.waiterCount === 1);
    service.failSubscriptions(new Error("subscription exploded"));
    await waitFor(() => reports.length === 2);
    expect(reports).toEqual([false, true]);

    await waitFor(() => service.subscribeCount >= 3 && service.waiterCount === 1);
    service.emit(rowUpdateEvent());
    await waitFor(() => service.waiterCount === 1);
    service.failSubscriptions(new Error("subscription exploded"));
    await waitFor(() => reports.length === 3);
    expect(reports[2]).toBe(false);
  });

  it("stops idempotently, closes the iterator, and refuses to restart", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    await runtime.stop();
    await runtime.stop();
    expect(service.cleanupCount).toBe(1);

    runtime.start();
    await delay(RECONNECT_OPTIONS.maxDelayMs * 2);
    expect(service.subscribeCount).toBe(1);
  });

  it("skips the initial load when an initial snapshot is provided", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();

    await waitFor(() => service.subscribeCount === 1);
    expect(service.loadCount).toBe(0);
    expect(runtime.getState().connection.state).toBe("connected");
    expect(runtime.getState().snapshot?.counts.worktrees).toBe(1);
  });

  it("commits service snapshot loads before resolving without firing hooks", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const outcomes: StationClientRefreshOutcome[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
        hooks: {
          onRefreshSettled: (outcome) => {
            outcomes.push(outcome);
          },
        },
      }),
    );

    runtime.start();
    await waitFor(() => service.subscribeCount === 1);
    const operationLoaded: StationSnapshot = {
      ...snapshot,
      rows: snapshot.rows.map((row) => ({ ...row, branch: "operation-loaded" })),
    };
    service.setSnapshot(operationLoaded);
    const loaded = await runtime.service.loadSnapshot();
    expect(loaded).toBe(runtime.getState().snapshot);
    expect(loaded).toBe(operationLoaded);
    expect(outcomes).toEqual([]);

    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().snapshot?.rows[0]?.display.statusLabel === "working");
    expect(runtime.getState().snapshot?.rows[0]?.branch).toBe("operation-loaded");

    const failing = new FakeObserverService(snapshot);
    failing.loadSnapshot = async () => {
      throw new Error("load exploded");
    };
    const failingRuntime = track(
      createStationClientRuntime({ service: failing, reconnect: RECONNECT_OPTIONS }),
    );
    const before = failingRuntime.getState();
    await expect(failingRuntime.service.loadSnapshot()).rejects.toThrow("load exploded");
    expect(failingRuntime.getState().snapshot).toBe(before.snapshot);
    expect(failingRuntime.getState().connection).toEqual(before.connection);
  });

  it("applies reconcile results through the loaded hook and rethrows failures untouched", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const outcomes: StationClientRefreshOutcome[] = [];
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
        hooks: {
          onRefreshSettled: (outcome) => {
            outcomes.push(outcome);
          },
        },
      }),
    );

    runtime.start();
    await waitFor(() => service.subscribeCount === 1);
    const operationLoaded: StationSnapshot = {
      ...snapshot,
      rows: snapshot.rows.map((row) => ({ ...row, branch: "reconciled-base" })),
    };
    service.setSnapshot(operationLoaded);
    const reconciled = await runtime.service.reconcile("manual");
    expect(service.reconcileReasons).toEqual(["manual"]);
    expect(reconciled).toBe(runtime.getState().snapshot);
    expect(reconciled).toBe(operationLoaded);
    expect(outcomes).toEqual([{ status: "loaded", snapshot: operationLoaded }]);

    service.emit(rowUpdateEvent());
    await waitFor(() => runtime.getState().snapshot?.rows[0]?.display.statusLabel === "working");
    expect(runtime.getState().snapshot?.rows[0]?.branch).toBe("reconciled-base");

    service.reconcile = async () => {
      throw new Error("reconcile exploded");
    };
    const before = runtime.getState();
    await expect(runtime.service.reconcile("again")).rejects.toThrow("reconcile exploded");
    expect(runtime.getState()).toBe(before);
    expect(outcomes).toHaveLength(1);
  });

  it("passes dispatch and completion waits through the runtime-owned service", async () => {
    const snapshot = createCommandSnapshot("idle");
    const service = new FakeObserverService(snapshot);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: snapshot,
        reconnect: RECONNECT_OPTIONS,
      }),
    );

    const receipt = await runtime.service.dispatch({
      type: "observer.reconcile",
      payload: { reason: "passthrough" },
    });
    expect(receipt).toBe(service.nextReceipt);
    expect(service.dispatched).toHaveLength(1);

    const completion = await runtime.service.waitForCommandCompletion(receipt.commandId);
    expect(completion).toBe(service.nextCompletion);
    expect(service.waitedForCommandIds).toEqual([receipt.commandId]);
  });

  it("resolves successful Group execution only after runtime state is canonical", async () => {
    const initial = createCommandSnapshot("idle");
    const canonical = {
      ...initial,
      sessionGroups: [sessionGroup({ id: "grp_loaded", name: "Loaded" })],
    };
    const service = new DeferredLoadService(canonical);
    const runtime = track(
      createStationClientRuntime({
        service,
        initialSnapshot: initial,
        reconnect: RECONNECT_OPTIONS,
      }),
    );
    runtime.start();
    await waitFor(() => service.subscribeCount === 1);

    let settled = false;
    const execution = executeObserverCommand(runtime.service, {
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Loaded" },
    }).finally(() => {
      settled = true;
    });
    await waitFor(() => service.loadCount === 1);
    expect(settled).toBe(false);
    expect(runtime.getState().snapshot).toBe(initial);

    service.releaseLoads();
    await expect(execution).resolves.toMatchObject({ status: "succeeded" });
    expect(runtime.getState().snapshot).toBe(canonical);
  });

  it("exposes inFlightRefresh while a load is pending", async () => {
    const service = new DeferredLoadService(createCommandSnapshot("idle"));
    const runtime = track(createStationClientRuntime({ service, reconnect: RECONNECT_OPTIONS }));
    runtime.start();

    await waitFor(() => runtime.getState().inFlightRefresh);
    service.releaseLoads();
    await waitFor(() => !runtime.getState().inFlightRefresh);
    expect(runtime.getState().connection.state).toBe("connected");
  });
});

class ConnectFailingService extends FakeObserverService {
  override async loadSnapshot(): Promise<StationSnapshot> {
    this.loadCount += 1;
    throw wrappedConnectError();
  }
}

class ColdStartConnectFailingService extends ConnectFailingService {
  override subscribeEvents(): AsyncIterable<StationEvent> {
    this.subscribeCount += 1;
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

function groupUpdatedEvent(
  group: ReturnType<typeof sessionGroup>,
): Extract<StationEvent, { type: "sessionGroup.updated" }> {
  return {
    type: "sessionGroup.updated",
    at: fixtureNow,
    commandId: "cmd_group_updated",
    group,
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
