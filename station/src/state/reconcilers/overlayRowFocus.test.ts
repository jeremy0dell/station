import { describe, expect, it } from "bun:test";
import type { StationSnapshot } from "@station/contracts";
import type { DashboardRuntime, DashboardRuntimeOptions } from "@station/dashboard-core/runtime";
import { manyProjectsSnapshot } from "../../station/fixtures/scenarios.js";
import { makeStationTestRuntime } from "../../station/test/support/makeStationTestRuntime.js";
import { createStationStore, type StationStore } from "../store.js";
import {
  agentWorktreePaneId,
  MAIN_PANE_ID,
  STATION_OVERLAY_ID,
  worktreePaneId,
} from "../types.js";
import { createOverlayRowFocusReconciler } from "./overlayRowFocus.js";

const FIRST_ROW_ID = "wt_station_working";
const FIRST_SESSION_ID = `ses_${FIRST_ROW_ID}`;
const SECOND_ROW_ID = "wt_obs_working";
const SECOND_SESSION_ID = `ses_${SECOND_ROW_ID}`;

describe("createOverlayRowFocusReconciler", () => {
  it("focuses the managed session from its primary pane or an auxiliary split", () => {
    for (const returnPane of ["primary", "auxiliary"] as const) {
      const stationStore = createStationStore({ boot: "empty" });
      addManagedTree(stationStore, "pane-agent", FIRST_SESSION_ID, "pane-shell");
      stationStore.actions.focusPane(returnPane === "primary" ? "pane-agent" : "pane-shell");
      const dashboardRuntime = loadedViewStore();
      const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

      stationStore.actions.openOverlay(STATION_OVERLAY_ID);

      expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
        kind: "session",
        sessionId: FIRST_SESSION_ID,
      });
      dispose();
    }
  });

  const unmatchedCases: ReadonlyArray<{
    label: string;
    arrangePane: (store: StationStore) => void;
  }> = [
    {
      label: "standalone shell",
      arrangePane: (store) => {
        store.actions.createPane(MAIN_PANE_ID);
        store.actions.focusPane(MAIN_PANE_ID);
      },
    },
    {
      label: "worktree-associated shell",
      arrangePane: (store) => {
        const paneId = worktreePaneId(FIRST_ROW_ID);
        store.actions.createPane(paneId);
        store.actions.focusPane(paneId);
      },
    },
    {
      label: "stale primary-agent identity",
      arrangePane: (store) => {
        const paneId = agentWorktreePaneId(FIRST_ROW_ID);
        store.actions.createPane(paneId, { role: "primary-agent" });
        store.actions.setPrimaryAgent(paneId, {
          sessionId: "ses_stale",
          terminalTargetId: "target-stale",
        });
        store.actions.focusPane(paneId);
      },
    },
  ];

  for (const { label, arrangePane } of unmatchedCases) {
    it(`does not infer a dashboard row from a ${label}`, () => {
      const stationStore = createStationStore({ boot: "empty" });
      arrangePane(stationStore);
      const dashboardRuntime = loadedViewStore({
        dashboardFocus: { kind: "session", sessionId: SECOND_SESSION_ID },
        scrollOffset: 2,
      });
      const initialOffset = dashboardRuntime.state.getState().scrollOffset;
      const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

      stationStore.actions.openOverlay(STATION_OVERLAY_ID);

      expect("dashboardFocus" in dashboardRuntime.state.getState()).toBe(false);
      expect(dashboardRuntime.state.getState().scrollOffset).toBe(initialOffset);
      dispose();
    });
  }

  it("clears focus on close and resolves the newly active pane when reopened", () => {
    const stationStore = createStationStore({ boot: "empty" });
    addManagedTree(stationStore, "pane-first", FIRST_SESSION_ID);
    addManagedTree(stationStore, "pane-second", SECOND_SESSION_ID);
    stationStore.actions.focusPane("pane-first");
    const dashboardRuntime = loadedViewStore();
    const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

    stationStore.actions.openOverlay(STATION_OVERLAY_ID);
    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
      kind: "session",
      sessionId: FIRST_SESSION_ID,
    });

    stationStore.actions.closeOverlay();
    expect("dashboardFocus" in dashboardRuntime.state.getState()).toBe(false);

    stationStore.actions.focusPane("pane-second");
    stationStore.actions.openOverlay(STATION_OVERLAY_ID);
    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
      kind: "session",
      sessionId: SECOND_SESSION_ID,
    });
    dispose();
  });

  it("synchronizes a delayed first snapshot once without snapping navigation back", () => {
    const stationStore = managedStore(FIRST_SESSION_ID);
    const fixture = unloadedViewRuntime();
    const dashboardRuntime = fixture.runtime;
    dashboardRuntime.start();
    const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

    stationStore.actions.openOverlay(STATION_OVERLAY_ID);
    expect("dashboardFocus" in dashboardRuntime.state.getState()).toBe(false);

    const firstSnapshot = manyProjectsSnapshot();
    fixture.source.setSnapshot(firstSnapshot);
    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
      kind: "session",
      sessionId: FIRST_SESSION_ID,
    });

    dashboardRuntime.actions.handleKey({ input: "", downArrow: true });
    const navigatedFocus = dashboardRuntime.state.getState().dashboardFocus;
    expect(navigatedFocus).not.toEqual({ kind: "session", sessionId: FIRST_SESSION_ID });

    dashboardRuntime.actions.dispatch({ type: "dashboard.scroll", delta: 1 });
    const scrolledOffset = dashboardRuntime.state.getState().scrollOffset;
    expect(scrolledOffset).toBeGreaterThan(0);

    const laterSnapshot: StationSnapshot = {
      ...firstSnapshot,
      generatedAt: "2026-06-12T12:01:00.000Z",
    };
    fixture.source.setSnapshot(laterSnapshot);

    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual(navigatedFocus);
    expect(dashboardRuntime.state.getState().scrollOffset).toBe(scrolledOffset);
    dispose();
  });

  it("cancels a pending first-snapshot synchronization when the overlay closes", () => {
    const stationStore = managedStore(FIRST_SESSION_ID);
    const fixture = unloadedViewRuntime();
    const dashboardRuntime = fixture.runtime;
    dashboardRuntime.start();
    const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

    stationStore.actions.openOverlay(STATION_OVERLAY_ID);
    stationStore.actions.closeOverlay();
    fixture.source.setSnapshot(manyProjectsSnapshot());

    expect("dashboardFocus" in dashboardRuntime.state.getState()).toBe(false);
    dispose();
  });

  it("disposes both the Station and dashboard subscriptions", () => {
    const stationStore = managedStore(FIRST_SESSION_ID);
    const fixture = unloadedViewRuntime();
    const dashboardRuntime = fixture.runtime;
    dashboardRuntime.start();
    const dispose = createOverlayRowFocusReconciler(stationStore, dashboardRuntime);

    stationStore.actions.openOverlay(STATION_OVERLAY_ID);
    dispose();
    dispose();

    fixture.source.setSnapshot(manyProjectsSnapshot());
    expect("dashboardFocus" in dashboardRuntime.state.getState()).toBe(false);

    dashboardRuntime.actions.focusDashboardSession(SECOND_SESSION_ID);
    stationStore.actions.closeOverlay();
    expect(dashboardRuntime.state.getState().dashboardFocus).toEqual({
      kind: "session",
      sessionId: SECOND_SESSION_ID,
    });
  });
});

function loadedViewStore(
  initialState?: DashboardRuntimeOptions["initialState"],
): DashboardRuntime {
  return makeStationTestRuntime({
    snapshot: manyProjectsSnapshot(),
    terminalRows: 12,
    ...(initialState === undefined ? {} : { initialState }),
  }).runtime;
}

function unloadedViewRuntime(): ReturnType<typeof makeStationTestRuntime> {
  return makeStationTestRuntime({ snapshot: null, terminalRows: 12 });
}

function managedStore(sessionId: string): StationStore {
  const store = createStationStore({ boot: "empty" });
  addManagedTree(store, "pane-agent", sessionId);
  store.actions.focusPane("pane-agent");
  return store;
}

function addManagedTree(
  store: StationStore,
  primaryPaneId: string,
  sessionId: string,
  auxiliaryPaneId?: string,
): void {
  store.actions.createPane(primaryPaneId, { role: "primary-agent" });
  store.actions.setPrimaryAgent(primaryPaneId, {
    sessionId,
    terminalTargetId: `target-${sessionId}`,
  });
  if (auxiliaryPaneId !== undefined) {
    store.actions.createPane(auxiliaryPaneId, {
      split: { anchorPaneId: primaryPaneId, direction: "right" },
    });
  }
}
