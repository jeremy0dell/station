import type { SessionGroupId } from "@station/contracts";
import {
  type DashboardCellId,
  type DashboardRowId,
  selectDashboardTree,
} from "../selectors/dashboardTree.js";
import { focusResolvedDashboardCursor, reconcileDashboardFocus } from "./dashboardFocus.js";
import { activateDashboardRow } from "./rowActivation.js";
import { openGroupMenu } from "./screens/groupMenu.js";
import { toggleDashboardProjectCollapsed } from "./screens/projectCollapse.js";
import { submitQuickSession, submitQuickSessionInGroup } from "./screens/quickSession.js";
import { openProjectMenu } from "./screens/sessionGroups.js";
import type { TuiTransition } from "./transition.js";
import type { DashboardState } from "./types.js";

export function activateDashboardCell(
  state: DashboardState,
  rowId: DashboardRowId,
  cellId: DashboardCellId,
): TuiTransition {
  if (state.screen.name !== "dashboard" || state.snapshot === undefined) {
    return { state };
  }
  const tree = selectDashboardTree(state.snapshot, state, state.screen);
  const row = tree.rowById.get(rowId);
  if (row === undefined || !tree.visibleIndexById.has(rowId) || !row.cells.includes(cellId)) {
    return { state };
  }
  const focused = focusResolvedDashboardCursor(state, tree, { rowId, cellId });
  switch (row.payload.type) {
    case "projectHeader":
      return activateProjectCell(focused, row.payload.project.id, cellId);
    case "groupHeader":
      if (cellId === "identity") {
        return { state: toggleDashboardGroupCollapsed(focused, row.payload.group.id) };
      }
      if (cellId === "quickSession") {
        return submitQuickSessionInGroup(focused, row.payload.group.id);
      }
      return { state: openGroupMenu(focused, row.payload.group.id) };
    case "session":
      return cellId === "identity" &&
        row.payload.pendingRemove === undefined &&
        row.payload.pendingStart === undefined
        ? activateDashboardRow(focused, row.payload.row)
        : { state: focused };
    case "emptyProject":
      return cellId === "addSession"
        ? submitQuickSession(focused, row.payload.project.id)
        : { state: focused };
    case "createLocalRow":
    case "groupFrameEnd":
    case "projectGap":
      return { state: focused };
  }
}

export function activateFocusedDashboardCell(state: DashboardState): TuiTransition {
  const focus = state.dashboardFocus;
  return focus === undefined ? { state } : activateDashboardCell(state, focus.rowId, focus.cellId);
}

function activateProjectCell(
  state: DashboardState,
  projectId: string,
  cellId: DashboardCellId,
): TuiTransition {
  switch (cellId) {
    case "identity":
      return { state: toggleDashboardProjectCollapsed(state, projectId) };
    case "shell":
      return {
        state,
        operations: [{ type: "openDashboardShell", target: { kind: "project", projectId } }],
      };
    case "quickSession":
      return submitQuickSession(state, projectId);
    case "menu":
      return { state: openProjectMenu(state, projectId) };
    case "addSession":
      return { state };
  }
}

function toggleDashboardGroupCollapsed(
  state: DashboardState,
  groupId: SessionGroupId,
): DashboardState {
  const collapsedGroupIds = new Set(state.collapsedGroupIds);
  if (collapsedGroupIds.has(groupId)) {
    collapsedGroupIds.delete(groupId);
  } else {
    collapsedGroupIds.add(groupId);
  }
  return reconcileDashboardFocus(state, { ...state, collapsedGroupIds });
}
