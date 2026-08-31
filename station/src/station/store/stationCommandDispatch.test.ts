// Station commands flow through the one shared @station/client boundary:
// dispatch and completion via observer service, reconcile and snapshot loads
// via client runtime (keeping store and runtime reducer synchronized).
import type { StationEvent, StationSnapshot } from "@station/contracts";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createObserverActivationCapabilities,
  createObserverManagedSessionCapabilities,
  createObserverWorktreeRemovalCapabilities,
  dashboardExecution,
} from "@station/dashboard-core/runtime";
import type { DashboardCapabilities } from "@station/dashboard-core/runtime";
import { dashboardRowIds, selectDashboardSlots } from "@station/dashboard-core/selectors";
import { createObserverStationClient } from "../../sources/observerStationClient.js";
import type { StationClient } from "../../sources/types.js";
import { waitFor } from "../../terminal/testing/waitFor.js";
import { createFakeFolderService } from "../test/support/fakeFolderService.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import { externalAgentSnapshot, manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { routeStationMouse } from "../input/stationMouse.js";
import { FakeTuiObserverService } from "../test/support/fakeObserverService.js";
import {
  createStationDashboardRuntime,
  type StationDashboardRuntime,
} from "./dashboardRuntime.js";

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
    const capabilities: DashboardCapabilities = {
      activation: createObserverActivationCapabilities({
        source: client.state,
        service: client.service,
        clientLabel: "Station test",
        waitForFocusCompletion: true,
      }),
      managedSessions: createObserverManagedSessionCapabilities({
        service: client.service,
        clientLabel: "Station test",
      }),
      worktreeRemoval: createObserverWorktreeRemovalCapabilities({
        service: client.service,
        clientLabel: "Station test",
      }),
      shell: { open: () => dashboardExecution({ kind: "success" }) },
      dismissal: {
        dismissDashboard: () => dashboardExecution({ kind: "success" }),
        exitRenderer: () => dashboardExecution({ kind: "success" }),
      },
    };
    const store = createStationDashboardRuntime(client, capabilities, {
      folderService: createFakeFolderService(),
    });
    store.start();
    client.start();
    const harness: Harness = { fake, client, store, detach: () => store.dispose() };
    harnesses.push(harness);
    await waitFor(
      () =>
        client.state.getState().connection.state === "connected" &&
        store.state.getState().snapshot !== undefined,
    );
    return harness;
  }

  it("row activation dispatches terminal.focus and waits for completion", async () => {
    const { fake, store } = await makeLiveStore();
    const slot = slotForRow(store, "ses_wt_station_idle");

    store.actions.handleKey({ input: slot });

    await waitFor(() => fake.waitedForCommandIds.length === 1);
    expect(fake.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_station_idle" } },
    ]);
    expect(fake.waitedForCommandIds).toEqual([fake.nextReceipt.commandId]);
    expect(errorToastMessages(store)).toEqual([]);
  });

  it("routes row clicks through the same semantic activation as keyboard", async () => {
    const { fake, store } = await makeLiveStore();

    const outcome = routeStationMouse(
      { kind: "dashboardCell", rowId: dashboardRowIds.session("ses_wt_station_idle"), cellId: "identity" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toEqual({ kind: "handled" });
    await waitFor(() => fake.waitedForCommandIds.length === 1);
    expect(fake.dispatched).toEqual([
      { type: "terminal.focus", payload: { sessionId: "ses_wt_station_idle" } },
    ]);
    expect(fake.waitedForCommandIds).toEqual([fake.nextReceipt.commandId]);
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

    const outcome = routeStationMouse(
      {
        kind: "dashboardCell",
        rowId: dashboardRowIds.session(external.id),
        cellId: "identity",
      },
      LEFT_DOWN,
      store,
    );

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

    store.actions.handleKey({ input: "Z" });

    await waitFor(() => toastMessages(store).includes("observer.reconcile refreshed"));
    expect(fake.reconcileReasons).toEqual(["tui-refresh"]);
    expect(client.state.getState().snapshot).toBe(reconciled);
    expect(store.state.getState().snapshot?.generatedAt).toBe(RECONCILED_AT);
  });

  it("keeps reconciled state when a later incremental event arrives", async () => {
    const { fake, store } = await makeLiveStore();
    const reconciled: StationSnapshot = {
      ...manyProjectsSnapshot(),
      generatedAt: RECONCILED_AT,
    };
    fake.setSnapshot(reconciled);
    store.actions.handleKey({ input: "Z" });
    await waitFor(() => store.state.getState().snapshot?.generatedAt === RECONCILED_AT);

    fake.emit(rowUpdateEvent("wt_station_idle"));

    // Pre-fix, the runtime reduced this event against its stale pre-reconcile
    // base and the mirror reverted the reconciled snapshot in the store.
    await waitFor(() => rowStatusLabel(store, "wt_station_idle") === "working");
    expect(store.state.getState().snapshot?.generatedAt).toBe(RECONCILED_AT);
  });

  it("shows the reconcile failure toast and clears loading", async () => {
    const { fake, store } = await makeLiveStore();
    fake.nextReconcileError = new Error("reconcile exploded");

    store.actions.handleKey({ input: "Z" });

    await waitFor(() => store.state.getState().toasts.length > 0);
    expect(store.state.getState().toasts[0]?.toast.kind).toBe("error");
    expect(store.state.getState().loading).toBe(false);
    expect(toastMessages(store)).not.toContain("observer.reconcile refreshed");
  });

  it("reconcile recovery flips the store to connected with the reconnect toast", async () => {
    const { fake, store } = await makeLiveStore();

    // Park the resubscribed cycle's resync so the subscription is live while
    // the store still shows displayOnly; the Z reconcile is then what proves
    // the resync and produces the connected transition.
    fake.pauseLoadSnapshot();
    fake.failSubscriptions(wrappedConnectError());
    await waitFor(() => store.state.getState().observerConnectionStatus.state === "displayOnly");
    await waitFor(() => fake.subscribeCount >= 2);

    // Let the outage cross the recovery-toast threshold without mutating the
    // runtime's read-only state boundary.
    await new Promise((resolve) => setTimeout(resolve, 1_501));
    store.actions.handleKey({ input: "Z" });

    await waitFor(() => store.state.getState().observerConnectionStatus.state === "connected");
    await waitFor(() => toastMessages(store).includes("Observer reconnected."));
    expect(toastMessages(store)).toContain("observer.reconcile refreshed");
    expect(store.state.getState().snapshot !== undefined).toBe(true);
  });
});

const RECONCILED_AT = "2026-06-12T12:30:00.000Z";

type Harness = {
  fake: FakeTuiObserverService;
  client: StationClient;
  store: StationDashboardRuntime;
  detach(): void;
};

function slotForRow(store: StationDashboardRuntime, rowId: string): string {
  const state = store.state.getState();
  if (state.snapshot === undefined) {
    throw new Error("store has no snapshot");
  }
  const choice = selectDashboardSlots(
    state.snapshot,
    state,
    state.screen,
    store.layout.snapshot(),
  ).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    throw new Error(`no slot for row ${rowId}`);
  }
  return choice.key;
}

function toastMessages(store: StationDashboardRuntime): string[] {
  return store.state.getState().toasts.map((entry) => entry.toast.message);
}

function errorToastMessages(store: StationDashboardRuntime): string[] {
  return store
    .state.getState()
    .toasts.filter((entry) => entry.toast.kind === "error")
    .map((entry) => entry.toast.message);
}

function rowStatusLabel(
  store: StationDashboardRuntime,
  rowId: string,
): string | undefined {
  return store.state.getState().snapshot?.rows.find((row) => row.id === rowId)?.display.statusLabel;
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
