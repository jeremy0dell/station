import type { StationSnapshot } from "@station/contracts";
import { reconcileNewSessionFlow } from "../flows/newSession/reconciliation.js";
import { selectMoveToGroupSessionContext } from "../selectors/sessionGroupChoices.js";
import { reconcileDashboardFocus } from "./dashboardFocus.js";
import { createEmptyTuiLocalRows, pruneLocalRowsForSnapshot } from "./localRows.js";
import { reconcileForkDetailsScreen } from "./screens/fork.js";
import { reconcileGroupSettingsScreen } from "./screens/groupSettings.js";
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
    groupHeaderActionVisibility: {
      quickSession: options.groupHeaderActionVisibility?.quickSession ?? true,
      menu: options.groupHeaderActionVisibility?.menu ?? true,
    },
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
  const transientSurface = reconcileTransientSurface(state, snapshot);
  const forkScreen =
    transientSurface.name === "fork" && transientSurface.step === "details"
      ? reconcileForkDetailsScreen(transientSurface, snapshot)
      : transientSurface;
  const flowScreen =
    forkScreen.name === "newSession"
      ? {
          name: "newSession" as const,
          flow: reconcileNewSessionFlow(forkScreen.flow, snapshot),
        }
      : forkScreen;
  const groupSettingsScreen =
    flowScreen.name === "groupSettings"
      ? (reconcileGroupSettingsScreen(flowScreen, snapshot) ?? { name: "dashboard" as const })
      : flowScreen;
  const screen =
    groupSettingsScreen.name === "moveToGroup" &&
    groupSettingsScreen.step !== "chooseSlot" &&
    selectMoveToGroupSessionContext(snapshot, groupSettingsScreen.sessionId) === undefined
      ? { name: "dashboard" as const }
      : groupSettingsScreen;
  const next: DashboardState = {
    ...state,
    screen,
    snapshot,
    loading: false,
    localRows: pruneLocalRowsForSnapshot(state.localRows, snapshot),
  };
  return seedNewSessionPickerCursor(reconcileDashboardFocus(state, next));
}

function reconcileTransientSurface(
  state: DashboardState,
  snapshot: StationSnapshot,
): DashboardState["screen"] {
  const screen = state.screen;
  if (screen.name === "groupMenu") {
    const group = snapshot.sessionGroups.find((candidate) => candidate.id === screen.groupId);
    return group?.projectId === screen.projectId ? screen : { name: "dashboard" };
  }
  if (screen.name !== "projectMenu" && screen.name !== "createGroup") return screen;
  return snapshot.projects.some((project) => project.id === screen.projectId)
    ? screen
    : { name: "dashboard" };
}
