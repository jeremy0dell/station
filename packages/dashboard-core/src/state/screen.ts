import type { StationSnapshot } from "@station/contracts";
import { reconcileDashboardFocus } from "./dashboardFocus.js";
import { createEmptyTuiLocalRows, pruneLocalRowsForSnapshot } from "./localRows.js";
import type { CreateInitialTuiStateOptions, DashboardState } from "./types.js";

export function createInitialTuiState(options: CreateInitialTuiStateOptions = {}): DashboardState {
  const state: DashboardState = {
    loading: options.initialSnapshot === undefined,
    screen: { name: "dashboard" },
    toasts: [],
    observerConnectionStatus: { state: "connected" },
    collapsedProjectIds: new Set(options.collapsedProjectIds ?? []),
    scrollOffset: options.scrollOffset ?? 0,
    terminalRows: options.terminalRows ?? 24,
    localRows: options.localRows ?? createEmptyTuiLocalRows(),
    selection: new Map(),
    widgets: options.widgets ?? [],
    widgetsPersisted: options.widgetsPersisted ?? true,
  };
  if (options.initialSnapshot !== undefined) {
    state.snapshot = options.initialSnapshot;
  }
  if (options.persistentFilter !== undefined) {
    state.persistentFilter = options.persistentFilter;
  }
  if (options.dashboardFocus !== undefined) {
    state.dashboardFocus = options.dashboardFocus;
  }
  return state.snapshot === undefined ? state : reconcileDashboardFocus(state, state);
}

export function replaceSnapshot(state: DashboardState, snapshot: StationSnapshot): DashboardState {
  const next: DashboardState = {
    ...state,
    snapshot,
    loading: false,
    localRows: pruneLocalRowsForSnapshot(state.localRows, snapshot),
  };
  return reconcileDashboardFocus(state, next);
}
