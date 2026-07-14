import type { TuiStore } from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
import { paneTreeIds } from "../paneTree.js";
import type { StationStore } from "../store.js";
import { STATION_OVERLAY_ID } from "../types.js";

/** Synchronizes native-pane identity to the dashboard cursor once per overlay open. */
export function createOverlayRowFocusReconciler(
  store: StationStore,
  stationViewStore: StoreApi<TuiStore>,
): () => void {
  let previousOverlay = store.getState().input.activeOverlay;
  let pendingSessionId: string | undefined;
  let disposed = false;

  const clearFocus = (): void => {
    stationViewStore.getState().clearDashboardFocus();
  };
  const synchronize = (sessionId: string): void => {
    const state = stationViewStore.getState();
    if (state.snapshot === undefined) {
      clearFocus();
      pendingSessionId = sessionId;
      return;
    }
    pendingSessionId = undefined;
    state.focusDashboardSession(sessionId);
  };

  const detachStationStore = store.subscribe(() => {
    const activeOverlay = store.getState().input.activeOverlay;
    const opened = previousOverlay !== STATION_OVERLAY_ID && activeOverlay === STATION_OVERLAY_ID;
    const closed = previousOverlay === STATION_OVERLAY_ID && activeOverlay !== STATION_OVERLAY_ID;
    previousOverlay = activeOverlay;

    if (opened) {
      pendingSessionId = undefined;
      // Pane-tree membership finds the explicit primary agent; pane ids and paths
      // are never treated as observer session identity.
      const sessionId = sessionIdForOverlayReturn(store);
      if (sessionId === undefined) {
        clearFocus();
      } else {
        synchronize(sessionId);
      }
    } else if (closed) {
      pendingSessionId = undefined;
      clearFocus();
    }
  });

  const detachDashboardStore = stationViewStore.subscribe((state) => {
    if (pendingSessionId === undefined || state.snapshot === undefined) {
      return;
    }
    // Clear before the dashboard action notifies subscribers so subsequent
    // cursor or scroll changes cannot resynchronize.
    const sessionId = pendingSessionId;
    pendingSessionId = undefined;
    state.focusDashboardSession(sessionId);
  });

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    pendingSessionId = undefined;
    detachStationStore();
    detachDashboardStore();
  };
}

function sessionIdForOverlayReturn(store: StationStore): string | undefined {
  const state = store.getState();
  const returnFocus = state.input.overlayReturnFocus;
  if (returnFocus?.kind !== "pane") {
    return undefined;
  }
  const treeIds = paneTreeIds(state.workspace.panes, returnFocus.paneId);
  return state.workspace.panes.find(
    (pane) => treeIds.has(pane.id) && pane.role === "primary-agent",
  )?.agentIdentity?.sessionId;
}
