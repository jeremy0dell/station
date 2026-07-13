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

  it("passes harness readiness queries through without refreshing runtime state", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const client = track(createObserverStationClient({ service: fake.service }));

    await expect(
      client.service.getHarnessReadiness({ provider: "codex", refresh: true }),
    ).resolves.toMatchObject({ readiness: { provider: "codex", decision: "launch_ready" } });
    expect(fake.readinessQueries).toEqual([{ provider: "codex", refresh: true }]);
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

  it("notifies the attention handler for needs_attention state changes", async () => {
    const fake = createFakeObserverService(mockObserverSnapshot);
    const attentionEvents: StationEvent[] = [];
    const client = track(
      createObserverStationClient({
        service: fake.service,
        onAttentionNeeded: (event) => {
          attentionEvents.push(event);
        },
      }),
    );

    client.start();
    await waitFor(() => client.state.getState().connection.state === "connected");
    expect(attentionEvents).toEqual([]);
    await waitFor(() => fake.hasParkedSubscriber());

    fake.emit(
      agentStateChangedEvent({
        state: "needs_attention",
        reason: "Codex proposed a plan.",
      }),
    );
    await waitFor(
      () =>
        client.state.getState().snapshot?.rows.find((row) => row.id === "wt_notify_cleanup")
          ?.agent?.state === "needs_attention",
    );
    await waitFor(() => attentionEvents.length === 1);
    expect(attentionEvents[0]).toMatchObject({
      type: "worktree.agentStateChanged",
      worktreeId: "wt_notify_cleanup",
      agent: { reason: "Codex proposed a plan." },
    });
    await waitFor(() => fake.hasParkedSubscriber());

    fake.emit(
      agentStateChangedEvent({
        state: "working",
        reason: "Codex resumed work.",
      }),
    );
    await waitFor(
      () =>
        client.state.getState().snapshot?.rows.find((row) => row.id === "wt_notify_cleanup")
          ?.agent?.state === "working",
    );
    await waitFor(() => fake.hasParkedSubscriber());

    fake.emit(
      agentStateChangedEvent({
        state: "needs_attention",
        reason: "Codex requested user input.",
        attention: "question",
        harnessEventType: "item/tool/requestUserInput",
      }),
    );
    await waitFor(() => attentionEvents.length === 2);
    expect(attentionEvents[1]).toMatchObject({
      type: "worktree.agentStateChanged",
      worktreeId: "wt_notify_cleanup",
      harnessEventType: "item/tool/requestUserInput",
    });
    await waitFor(() => fake.hasParkedSubscriber());

    fake.emit(
      agentStateChangedEvent({
        state: "needs_attention",
        reason: "Codex requested permission for Bash.",
        attention: "tool_approval",
      }),
    );
    await waitFor(() => attentionEvents.length === 3);
    expect(attentionEvents[2]).toMatchObject({
      type: "worktree.agentStateChanged",
      worktreeId: "wt_notify_cleanup",
      agent: {
        reason: "Codex requested permission for Bash.",
      },
    });
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
  const readinessQueries: Array<{ provider: string; refresh?: boolean }> = [];

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
    getHarnessReadiness: async (params) => {
      readinessQueries.push(params);
      return {
        readiness: {
          provider: params.provider,
          label: params.provider,
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
          explanation: `${params.provider} is prepared for Station.`,
          actions: ["use", "technical_details"],
          technicalDetails: [],
        },
      };
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
    readinessQueries,
    setSnapshot: (next: StationSnapshot) => {
      snapshot = next;
    },
    emit: (event: StationEvent) => {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        throw new Error("No observer subscriber is waiting for an event.");
      }
      waiter.resolve({ done: false, value: event });
    },
    hasParkedSubscriber: () => waiters.length > 0,
    failSubscription: (error: Error) => {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
  };
}

function agentStateChangedEvent(input: {
  state: "working" | "needs_attention";
  reason: string;
  attention?: "question" | "tool_approval";
  harnessEventType?: string;
}): StationEvent {
  const event: StationEvent = {
    type: "worktree.agentStateChanged",
    worktreeId: "wt_notify_cleanup",
    agent: {
      harness: "codex",
      state: input.state,
      runId: "run_notify_cleanup",
      sessionId: "ses_notify_cleanup",
      confidence: "high",
      reason: input.reason,
      updatedAt: "2026-06-11T12:01:00.000Z",
      ...(input.attention === undefined ? {} : { attention: input.attention }),
    },
  };
  if (input.harnessEventType !== undefined) {
    event.harnessEventType = input.harnessEventType;
  }
  return event;
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
