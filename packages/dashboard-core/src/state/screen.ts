import type { StationSnapshot } from "@station/contracts";
import { reconcileDashboardFocus } from "./dashboardFocus.js";
import { createEmptyTuiLocalRows, pruneLocalRowsForSnapshot } from "./localRows.js";
import type { CreateInitialTuiStateOptions, TuiRuntimeState, TuiState } from "./types.js";

export function createInitialTuiState(options: CreateInitialTuiStateOptions = {}): TuiState {
  const runtime = createRuntimeState(options.runtime);
  const state: TuiState = {
    loading: options.initialSnapshot === undefined,
    screen: { name: "dashboard" },
    toasts: [],
    observerConnectionStatus: { state: "connected" },
    searchQuery: options.searchQuery ?? "",
    collapsedProjectIds: new Set(options.collapsedProjectIds ?? []),
    scrollOffset: options.scrollOffset ?? 0,
    terminalRows: options.terminalRows ?? 24,
    localRows: options.localRows ?? createEmptyTuiLocalRows(),
    selection: new Map(),
    widgets: options.widgets ?? [],
    widgetsPersisted: options.widgetsPersisted ?? true,
    runtime,
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

export function replaceSnapshot(state: TuiState, snapshot: StationSnapshot): TuiState {
  const next: TuiState = {
    ...state,
    snapshot,
    loading: false,
    localRows: pruneLocalRowsForSnapshot(state.localRows, snapshot),
  };
  return reconcileDashboardFocus(state, next);
}

function createRuntimeState(runtime: Partial<TuiRuntimeState> | undefined): TuiRuntimeState {
  const built: TuiRuntimeState = {
    persistentPopup: runtime?.persistentPopup ?? false,
    canDismissPopup: runtime?.canDismissPopup ?? false,
    exitOnFocusSuccess: runtime?.exitOnFocusSuccess ?? false,
    canResolveFocusOrigin: runtime?.canResolveFocusOrigin ?? false,
    hasFocusSuccessCallback: runtime?.hasFocusSuccessCallback ?? false,
  };
  if (runtime?.focusOrigin !== undefined) {
    built.focusOrigin = runtime.focusOrigin;
  }
  return built;
}
