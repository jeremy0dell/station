import type { StationSnapshot } from "@station/contracts";
import { reconcileNewSessionFlow } from "../flows/newSession.js";
import { reconcileDashboardFocus } from "./dashboardFocus.js";
import { createEmptyTuiLocalRows, pruneLocalRowsForSnapshot } from "./localRows.js";
import { seedNewSessionPickerCursor } from "./selection/specs/newSession.js";
import type { CreateInitialTuiStateOptions, DashboardState } from "./types.js";

export function createInitialTuiState(options: CreateInitialTuiStateOptions = {}): DashboardState {
  const state: DashboardState = {
    loading: options.initialSnapshot === undefined,
    screen: { name: "dashboard" },
    toasts: [],
    observerConnectionStatus: { state: "connected" },
    collapsedProjectIds: new Set(options.collapsedProjectIds ?? []),
    collapsedGroupIds: new Set(options.collapsedGroupIds ?? []),
    groupOrderingMode: options.groupOrderingMode ?? "groups-first",
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
  const projectSurface = reconcileProjectSurface(state, snapshot);
  const screen =
    projectSurface.name === "newSession"
      ? {
          name: "newSession" as const,
          flow: reconcileNewSessionFlow(projectSurface.flow, snapshot),
        }
      : projectSurface;
  const next: DashboardState = {
    ...state,
    screen,
    snapshot,
    loading: false,
    localRows: pruneLocalRowsForSnapshot(state.localRows, snapshot),
  };
  return seedNewSessionPickerCursor(reconcileDashboardFocus(state, next));
}

function reconcileProjectSurface(
  state: DashboardState,
  snapshot: StationSnapshot,
): DashboardState["screen"] {
  const screen = state.screen;
  if (screen.name !== "projectMenu" && screen.name !== "createGroup") return screen;
  return snapshot.projects.some((project) => project.id === screen.projectId)
    ? screen
    : { name: "dashboard" };
}
