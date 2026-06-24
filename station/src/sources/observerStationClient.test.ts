import type { ObserverService } from "@station/client";
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { afterEach, describe, expect, it } from "bun:test";
import { mockObserverSnapshot } from "./fixtures/mockObserverSnapshot.js";
import { createObserverStationClient } from "./observerStationClient.js";
import type { StationClient } from "./types.js";

describe("createObserverStationClient", () => {
  const clients: StationClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.stop();
    }
  });

  function track(client: StationClient): StationClient {
    clients.push(client);
    return client;
  }

  it("reaches connected with the observer snapshot through the shared runtime", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));

    expect(client.state.getState().connection.state).toBe("idle");
    client.start();

    await waitFor(() => client.state.getState().connection.state === "connected");
    expect(client.state.getState().snapshot).toBe(mockObserverSnapshot);
    expect(client.state.getState().snapshot?.counts.worktrees).toBe(
      mockObserverSnapshot.counts.worktrees,
    );
  });

  it("passes dispatch and command-completion waits through to the shared connection", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));

    const receipt = await client.service.dispatch({
      type: "observer.reconcile",
      payload: { reason: "station-test" },
    });
    const completion = await client.service.waitForCommandCompletion(receipt.commandId);

    expect(fake.dispatchedTypes).toEqual(["observer.reconcile"]);
    expect(fake.waitedForCommandIds).toEqual([receipt.commandId]);
    expect(completion.status).toBe("succeeded");
  });

  it("routes service.reconcile through the runtime so client state converges", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));
    client.start();
    await waitFor(() => client.state.getState().connection.state === "connected");

    const reconciled: StationSnapshot = {
      ...mockObserverSnapshot,
      generatedAt: "2026-06-12T12:00:01.000Z",
    };
    fake.setSnapshot(reconciled);
    const loaded = await client.service.reconcile("station-test");

    expect(fake.reconcileReasons).toEqual(["station-test"]);
    expect(loaded).toBe(reconciled);
    expect(client.state.getState().snapshot).toBe(reconciled);
  });

  it("routes service.loadSnapshot through the runtime refresh", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));
    client.start();
    await waitFor(() => client.state.getState().connection.state === "connected");

    const refreshed: StationSnapshot = {
      ...mockObserverSnapshot,
      generatedAt: "2026-06-12T12:00:02.000Z",
    };
    fake.setSnapshot(refreshed);
    const loaded = await client.service.loadSnapshot();

    expect(loaded).toBe(refreshed);
    expect(client.state.getState().snapshot).toBe(refreshed);
  });

  it("keeps the last good snapshot with a calm display-only status when the observer goes away", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));
    client.start();
    await waitFor(() => client.state.getState().connection.state === "connected");

    await waitFor(() => fake.hasParkedSubscriber());
    fake.failSubscription(wrappedConnectError());

    await waitFor(() => client.state.getState().connection.state === "displayOnly");
    expect(client.state.getState().snapshot).toBe(mockObserverSnapshot);
  });

  it("notifies subscribers when state changes", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));
    let notified = 0;
    client.state.subscribe(() => {
      notified += 1;
    });

    client.start();
    await waitFor(() => client.state.getState().connection.state === "connected");
    expect(notified).toBeGreaterThan(0);
  });

  it("requires a socket path or service", () => {
    expect(() => createObserverStationClient({})).toThrow(/socketPath or service/);
  });
});

type Waiter = {
  resolve(result: IteratorResult<StationEvent>): void;
  reject(error: Error): void;
};

function createFakeObserverService(initialSnapshot: StationSnapshot) {
  let snapshot = initialSnapshot;
  const waiters: Waiter[] = [];
  const dispatchedTypes: string[] = [];
  const waitedForCommandIds: string[] = [];
  const reconcileReasons: Array<string | undefined> = [];

  const service: ObserverService = {
    loadSnapshot: async () => snapshot,
    subscribeEvents: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<StationEvent>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          }),
        return: async () => {
          for (const waiter of waiters.splice(0)) {
            waiter.resolve({ done: true, value: undefined });
          }
          return { done: true, value: undefined };
        },
      }),
    }),
    dispatch: async (command) => {
      dispatchedTypes.push(command.type);
      return {
        commandId: "cmd_station_test",
        accepted: true,
        status: "accepted",
      };
    },
    waitForCommandCompletion: async (commandId) => {
      waitedForCommandIds.push(commandId);
      return {
        status: "succeeded",
        commandId,
      };
    },
    reconcile: async (reason) => {
      reconcileReasons.push(reason);
      return snapshot;
    },
    prepareExternalLaunch: async (params) => ({
      kind: "existing-session",
      sessionId: `ses_${params.worktreeId}`,
      harnessProvider: "fake-harness",
    }),
    reportExternalExit: async (params) => ({
      acknowledged: true,
      terminalTargetId: params.terminalTargetId,
    }),
  };

  return {
    service,
    dispatchedTypes,
    waitedForCommandIds,
    reconcileReasons,
    setSnapshot: (next: StationSnapshot) => {
      snapshot = next;
    },
    hasParkedSubscriber: () => waiters.length > 0,
    failSubscription: (error: Error) => {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
  };
}

function wrappedConnectError(): Error {
  const error = new Error("wrapped connect failure");
  (error as Error & { cause?: unknown }).cause = {
    tag: "ProtocolError",
    code: "PROTOCOL_CONNECT_FAILED",
    message: "Could not connect to the observer socket.",
  };
  return error;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
