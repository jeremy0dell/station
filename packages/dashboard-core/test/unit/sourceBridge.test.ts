import type { StationClientConnectionState } from "@station/client";
import type { SafeError, StationSnapshot } from "@station/contracts";
import {
  applySnapshotSourceState,
  attachTuiSnapshotSource,
  createInitialTuiState,
  type TuiSnapshotSource,
  type TuiSnapshotSourceState,
  type TuiState,
  type TuiStore,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createDashboardSnapshot, createZeroWorktreeSnapshot } from "../fixtures/snapshots.js";

const NOW = 1_750_000_000_000;

const lastError: SafeError = {
  tag: "ProtocolError",
  code: "PROTOCOL_CONNECT_FAILED",
  message: "Could not connect to the observer socket.",
};

describe("applySnapshotSourceState", () => {
  it("returns the same state when a no-snapshot failure update is content-identical", () => {
    const initial = createInitialTuiState();
    const connection: StationClientConnectionState = {
      state: "reconnecting",
      since: NOW - 500,
      lastError,
    };

    const first = applySnapshotSourceState(initial, { connection }, NOW);
    expect(first.observerConnectionStatus.state).toBe("reconnecting");

    const second = applySnapshotSourceState(first, { connection }, NOW + 50);
    expect(second).toBe(first);
  });

  it("returns the same state when a display-only update is content-identical", () => {
    // Only identity matters on this path; the snapshot's fields are never read.
    const snapshot = {} as StationSnapshot;
    const initial: TuiState = { ...createInitialTuiState(), snapshot };
    const connection: StationClientConnectionState = {
      state: "displayOnly",
      since: NOW - 500,
      lastError,
    };

    const first = applySnapshotSourceState(initial, { snapshot, connection }, NOW);
    expect(first.observerConnectionStatus.state).toBe("displayOnly");
    expect(first.loading).toBe(false);

    const second = applySnapshotSourceState(first, { snapshot, connection }, NOW + 50);
    expect(second).toBe(first);
  });

  it("reconciles dashboard focus when a source snapshot replaces the list", () => {
    const snapshot = createDashboardSnapshot();
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        kind: "projectHeader",
        projectId: "web",
        control: "defaultAgent",
      },
    });
    const withoutWeb = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "web"),
      rows: snapshot.rows.filter((row) => row.projectId !== "web"),
      sessions: snapshot.sessions.filter((session) => session.projectId !== "web"),
    };

    const replaced = applySnapshotSourceState(
      initial,
      {
        snapshot: withoutWeb,
        connection: { state: "connected", since: NOW },
      },
      NOW,
    );

    expect(replaced.dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "api",
      control: "primary",
    });
  });

  it("preserves or positionally reconciles empty-project focus across source snapshots", () => {
    const snapshot = createZeroWorktreeSnapshot();
    const initial = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { kind: "emptyProjectAction", projectId: "web" },
    });
    const connected = { state: "connected" as const, since: NOW };

    const preserved = applySnapshotSourceState(
      initial,
      { snapshot: { ...snapshot, generatedAt: "2026-05-20T12:01:00.000Z" }, connection: connected },
      NOW,
    );
    expect(preserved.dashboardFocus).toEqual({ kind: "emptyProjectAction", projectId: "web" });

    const reconciled = applySnapshotSourceState(
      initial,
      { snapshot: createDashboardSnapshot(), connection: connected },
      NOW,
    );
    expect(reconciled.dashboardFocus).toEqual({
      kind: "session",
      sessionId: "ses_wt_web_working",
    });
  });

  it("still produces a new state when the failure status actually changes", () => {
    const initial = createInitialTuiState();
    const first = applySnapshotSourceState(
      initial,
      { connection: { state: "reconnecting", since: NOW - 500, lastError } },
      NOW,
    );

    const second = applySnapshotSourceState(
      first,
      { connection: { state: "reconnecting", since: NOW - 100, lastError } },
      NOW + 50,
    );

    expect(second).not.toBe(first);
    expect(second.observerConnectionStatus).toMatchObject({ since: NOW - 100 });
  });
});

describe("attachTuiSnapshotSource subscriber churn", () => {
  it("does not notify store subscribers when the source re-emits an equal failure", () => {
    const store = makeStore();
    const source = new ControllableSource({ connection: { state: "loading", since: NOW } });
    const detach = attachTuiSnapshotSource(store, source);

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    // First failure changes the status: one notification.
    source.set({ connection: { state: "reconnecting", since: NOW, lastError } });
    expect(notifications).toBe(1);
    expect(store.getState().observerConnectionStatus.state).toBe("reconnecting");

    // The runtime-churn shape: a freshly allocated but value-equal error on
    // every re-notify. Reference compare would re-render here; value compare
    // coalesces, so the subscriber stays silent.
    source.set({ connection: { state: "reconnecting", since: NOW, lastError: { ...lastError } } });
    source.set({ connection: { state: "reconnecting", since: NOW, lastError: { ...lastError } } });
    expect(notifications).toBe(1);

    detach();
  });
});

class ControllableSource implements TuiSnapshotSource {
  private readonly listeners = new Set<() => void>();
  constructor(private state: TuiSnapshotSourceState) {}
  getState(): TuiSnapshotSourceState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(state: TuiSnapshotSourceState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function makeStore(): StoreApi<TuiStore> {
  return createStore<TuiStore>()(() => ({
    ...createInitialTuiState(),
    start: () => () => {},
    handleKey: () => ({ dismissPopup: false }),
    dispatch: () => ({ dismissPopup: false }),
    createQuickSession: () => {},
    setTerminalRows: () => {},
    focusDashboardSession: () => {},
    clearDashboardFocus: () => {},
    pushToast: () => {},
    dismissToasts: () => {},
    expireToasts: () => {},
    refreshActiveToastExpiry: () => {},
    addPendingCreateSession: () => {},
    failPendingCreateSession: () => {},
    removePendingCreateSession: () => {},
  }));
}
