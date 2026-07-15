// Station commands flow through the one shared @station/client boundary:
// dispatch and completion via observer service, reconcile and snapshot loads
// via client runtime (keeping store and runtime reducer synchronized).
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { afterEach, describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import { selectDashboardViewport, type TuiStore } from "@station/dashboard-core";
import { createObserverStationClient } from "../../sources/observerStationClient.js";
import type { StationClient } from "../../sources/types.js";
import { waitFor } from "../../terminal/testing/waitFor.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import { externalAgentSnapshot, manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { routeStationMouse } from "../input/stationMouse.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import { createStationViewStore } from "./stationViewStore.js";

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 5,
  y: 5,
  modifiers: { shift: false, alt: false, ctrl: false },
};

describe("station command dispatch through the shared client", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      harness.fake.resumeLoadSnapshot();
      harness.detach();
      await harness.client.stop();
    }
  });

  async function makeLiveStore(snapshot = manyProjectsSnapshot()): Promise<Harness> {
    const fake = new FakeTuiObserverService(snapshot);
    const client = createObserverStationClient({ service: fake });
    const store = createStationViewStore(client);
    const detach = store.getState().start();
    client.start();
    const harness: Harness = { fake, client, store, detach };
    harnesses.push(harness);
    await waitFor(
      () =>
        client.state.getState().connection.state === "connected" &&
        store.getState().snapshot !== undefined,
    );
    return harness;
  }

  it("row activation dispatches terminal.focus and waits for completion", async () => {
    const { fake, store } = await makeLiveStore();
    const slot = slotForRow(store, "ses_wt_station_idle");

    store.getState().handleKey({ input: slot });

    await waitFor(() => fake.waitedForCommandIds.length === 1);
    expect(fake.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_station_idle" } },
    ]);
    expect(fake.waitedForCommandIds).toEqual([fake.nextReceipt.commandId]);
    expect(errorToastMessages(store)).toEqual([]);
  });

  it("launches the worktree's managed primary agent on row click instead of dispatching focus", async () => {
    const { fake, store } = await makeLiveStore();

    const outcome = routeStationMouse(
      { kind: "row", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      store,
    );

    // The mouse row-click now launches the session's managed primary agent (a
    // router outcome the Station store consumes that asks the observer to
    // prepare the launch), so it no longer dispatches the observer/tmux
    // terminal.focus the keyboard slot key still drives.
    expect(outcome).toMatchObject({
      kind: "launch-managed",
      paneId: "pane-agent-wt-wt_station_idle",
      worktreeId: "wt_station_idle",
      projectId: "station",
    });
    // Let any (unexpected) async dispatch settle, then assert none happened.
    await Promise.resolve();
    expect(fake.dispatched).toEqual([]);
    expect(fake.waitedForCommandIds).toEqual([]);
    expect(errorToastMessages(store)).toEqual([]);
  });

  it("routes an external session click through exact observer focus", async () => {
    const base = externalAgentSnapshot();
    const external = base.sessions.find((session) => session.origin === "external");
    if (external === undefined) throw new Error("external fixture session is missing");
    const snapshot = {
      ...base,
      sessions: base.sessions.map((session) =>
        session.id === external.id
          ? {
              ...session,
              terminal: {
                provider: "tmux",
                state: "open" as const,
                focusable: true,
                closeable: true,
              },
            }
          : session,
      ),
    };
    const { fake, store } = await makeLiveStore(snapshot);

    const outcome = routeStationMouse({ kind: "row", rowId: external.id }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    await waitFor(() => fake.waitedForCommandIds.length === 1);
    expect(fake.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: external.id } },
    ]);
  });

  it("routes Z refresh through the client runtime", async () => {
    const { fake, client, store } = await makeLiveStore();
    const reconciled: StationSnapshot = {
      ...manyProjectsSnapshot(),
      generatedAt: RECONCILED_AT,
    };
    fake.setSnapshot(reconciled);

    store.getState().handleKey({ input: "Z" });

    await waitFor(() => toastMessages(store).includes("observer.reconcile refreshed"));
    expect(fake.reconcileReasons).toEqual(["tui-refresh"]);
    expect(client.state.getState().snapshot).toBe(reconciled);
    expect(store.getState().snapshot?.generatedAt).toBe(RECONCILED_AT);
  });

  it("keeps reconciled state when a later incremental event arrives", async () => {
    const { fake, store } = await makeLiveStore();
    const reconciled: StationSnapshot = {
      ...manyProjectsSnapshot(),
      generatedAt: RECONCILED_AT,
    };
    fake.setSnapshot(reconciled);
    store.getState().handleKey({ input: "Z" });
    await waitFor(() => store.getState().snapshot?.generatedAt === RECONCILED_AT);

    fake.emit(rowUpdateEvent("wt_station_idle"));

    // Pre-fix, the runtime reduced this event against its stale pre-reconcile
    // base and the mirror reverted the reconciled snapshot in the store.
    await waitFor(() => rowStatusLabel(store, "wt_station_idle") === "working");
    expect(store.getState().snapshot?.generatedAt).toBe(RECONCILED_AT);
  });

  it("shows the reconcile failure toast and clears loading", async () => {
    const { fake, store } = await makeLiveStore();
    fake.nextReconcileError = new Error("reconcile exploded");

    store.getState().handleKey({ input: "Z" });

    await waitFor(() => store.getState().toasts.length > 0);
    expect(store.getState().toasts[0]?.toast.kind).toBe("error");
    expect(store.getState().loading).toBe(false);
    expect(toastMessages(store)).not.toContain("observer.reconcile refreshed");
  });

  it("reconcile recovery flips the store to connected with the reconnect toast", async () => {
    const { fake, store } = await makeLiveStore();

    // Park the resubscribed cycle's resync so the subscription is live while
    // the store still shows displayOnly; the Z reconcile is then what proves
    // the resync and produces the connected transition.
    fake.pauseLoadSnapshot();
    fake.failSubscriptions(wrappedConnectError());
    await waitFor(() => store.getState().observerConnectionStatus.state === "displayOnly");
    await waitFor(() => fake.subscribeCount >= 2);

    const current = store.getState().observerConnectionStatus;
    if (current.state !== "displayOnly") {
      throw new Error("expected a displayOnly connection status");
    }
    // Backdate the outage past the recovery-toast threshold.
    store.setState({
      observerConnectionStatus: { ...current, since: Date.now() - 3_000 },
    });

    store.getState().handleKey({ input: "Z" });

    await waitFor(() => store.getState().observerConnectionStatus.state === "connected");
    await waitFor(() => toastMessages(store).includes("Observer reconnected."));
    expect(toastMessages(store)).toContain("observer.reconcile refreshed");
    expect(store.getState().snapshot !== undefined).toBe(true);
  });
});

const RECONCILED_AT = "2026-06-12T12:30:00.000Z";

type Harness = {
  fake: FakeTuiObserverService;
  client: StationClient;
  store: StoreApi<TuiStore>;
  detach(): void;
};

function slotForRow(store: StoreApi<TuiStore>, rowId: string): string {
  const state = store.getState();
  if (state.snapshot === undefined) {
    throw new Error("store has no snapshot");
  }
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    throw new Error(`no slot for row ${rowId}`);
  }
  return choice.key;
}

function toastMessages(store: StoreApi<TuiStore>): string[] {
  return store.getState().toasts.map((entry) => entry.toast.message);
}

function errorToastMessages(store: StoreApi<TuiStore>): string[] {
  return store
    .getState()
    .toasts.filter((entry) => entry.toast.kind === "error")
    .map((entry) => entry.toast.message);
}

function rowStatusLabel(store: StoreApi<TuiStore>, rowId: string): string | undefined {
  return store.getState().snapshot?.rows.find((row) => row.id === rowId)?.display.statusLabel;
}

function rowUpdateEvent(worktreeId: string): StationEvent {
  return {
    type: "worktree.updated",
    worktreeId,
    patch: {
      display: {
        statusLabel: "working",
        sortPriority: 30,
        alert: false,
        reason: "Live event after reconcile.",
      },
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
