import type { ProjectId, SessionGroupId, SessionId } from "@station/contracts";
import type { DashboardSessionRow } from "../selectors/dashboardSessionRows.js";
import {
  type DashboardCellId,
  type DashboardFocus,
  type DashboardRowId,
  type DashboardTreePayload,
  type DashboardTreeProjection,
  type DashboardTreeRow,
  dashboardRowIds,
  selectDashboardTree,
} from "../selectors/dashboardTree.js";
import {
  moveTreeGridCursor,
  reconcileTreeGridCursor,
  type TreeGridNavigationPolicy,
  treeGridCursorForRow,
} from "../treeGrid.js";
import type { DashboardState } from "./types.js";

type DashboardPolicy = TreeGridNavigationPolicy<
  DashboardRowId,
  DashboardCellId,
  DashboardTreePayload
>;

const dashboardPolicy: DashboardPolicy = ({ payload }) =>
  payload.type === "projectHeader" ||
  payload.type === "groupHeader" ||
  payload.type === "session" ||
  payload.type === "emptyProject";

// This one policy protects canonical-session-only chooser entry, movement,
// reconciliation, Enter, and slot behavior; callers use only the bound wrappers below.
const chooserPolicy: DashboardPolicy = ({ payload }) =>
  payload.type === "session" &&
  payload.pendingRemove === undefined &&
  payload.pendingStart === undefined;

const needsAttentionPolicy: DashboardPolicy = ({ payload }) =>
  payload.type === "session" && rowNeedsYou(payload.row);

/** Focuses the visible dashboard row for a canonical session identity. */
export function focusDashboardSession(state: DashboardState, sessionId: SessionId): DashboardState {
  if (state.snapshot === undefined) {
    return clearDashboardFocus(state);
  }
  const revealed = revealSessionAncestry(state, sessionId);
  const tree = dashboardTree(revealed);
  const cursor = treeGridCursorForRow({
    projection: tree,
    rowId: dashboardRowIds.session(sessionId),
    preferredCell: "identity",
    policy: dashboardPolicy,
  });
  return cursor === undefined
    ? clearDashboardFocus(revealed)
    : focusResolvedDashboardCursor(revealed, tree, cursor);
}

function revealSessionAncestry(state: DashboardState, sessionId: SessionId): DashboardState {
  const snapshot = state.snapshot;
  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  if (snapshot === undefined || session === undefined) return state;
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const collapsedGroupIds = new Set(state.collapsedGroupIds);
  collapsedProjectIds.delete(session.projectId);
  let group = snapshot.sessionGroups.find((candidate) => candidate.sessionIds.includes(sessionId));
  while (group !== undefined) {
    collapsedGroupIds.delete(group.id);
    const parentId = group.parentGroupId;
    group =
      parentId === undefined
        ? undefined
        : snapshot.sessionGroups.find((candidate) => candidate.id === parentId);
  }
  return { ...state, screen: { name: "dashboard" }, collapsedProjectIds, collapsedGroupIds };
}

/** Focuses one canonical Project header control. */
export function focusDashboardProject(
  state: DashboardState,
  projectId: ProjectId,
  cellId: Extract<DashboardCellId, "identity" | "menu"> = "identity",
): DashboardState {
  if (state.snapshot?.projects.some((candidate) => candidate.id === projectId) !== true) {
    return clearDashboardFocus({ ...state, screen: { name: "dashboard" } });
  }
  const dashboard = { ...state, screen: { name: "dashboard" as const } };
  const tree = dashboardTree(dashboard);
  const cursor = treeGridCursorForRow({
    projection: tree,
    rowId: dashboardRowIds.project(projectId),
    preferredCell: cellId,
    policy: dashboardPolicy,
  });
  return cursor === undefined
    ? clearDashboardFocus(dashboard)
    : focusResolvedDashboardCursor(dashboard, tree, cursor);
}

/** Reveals and focuses one canonical Group header cell. */
export function focusDashboardGroup(
  state: DashboardState,
  groupId: SessionGroupId,
  cellId: Extract<DashboardCellId, "identity" | "quickSession" | "menu"> = "identity",
): DashboardState {
  const group = state.snapshot?.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return clearDashboardFocus(state);
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const collapsedGroupIds = new Set(state.collapsedGroupIds);
  collapsedProjectIds.delete(group.projectId);
  collapsedGroupIds.delete(groupId);
  const dashboard = {
    ...state,
    screen: { name: "dashboard" as const },
    collapsedProjectIds,
    collapsedGroupIds,
  };
  const tree = dashboardTree(dashboard);
  const cursor = treeGridCursorForRow({
    projection: tree,
    rowId: dashboardRowIds.group(groupId),
    preferredCell: cellId,
    policy: dashboardPolicy,
  });
  return cursor === undefined
    ? clearDashboardFocus(dashboard)
    : focusResolvedDashboardCursor(dashboard, tree, cursor);
}

/** Removes transient dashboard focus without disturbing other view state. */
export function clearDashboardFocus(state: DashboardState): DashboardState {
  if (state.dashboardFocus === undefined) {
    return state;
  }
  const cleared = { ...state };
  delete cleared.dashboardFocus;
  return cleared;
}

/** Moves vertically through Project, Group, canonical-session, and empty-action rows. */
export function moveDashboardCursor(
  state: DashboardState,
  delta: -1 | 1,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardState {
  return moveCursor(state, delta, dashboardPolicy, visibleRowIds);
}

/** Moves within the current row's ordered cells, clamping without wrapping. */
export function moveDashboardCursorHorizontal(
  state: DashboardState,
  delta: -1 | 1,
): DashboardState {
  if (state.snapshot === undefined || state.dashboardFocus === undefined) {
    return state;
  }
  const tree = dashboardTree(state);
  const cursor = exactCursor(tree, state.dashboardFocus, dashboardPolicy);
  if (cursor === undefined) {
    return state;
  }
  const moved = moveTreeGridCursor({
    projection: tree,
    cursor,
    direction: delta < 0 ? "left" : "right",
    policy: dashboardPolicy,
  });
  return sameCursor(moved, cursor) ? state : focusResolvedDashboardCursor(state, tree, moved);
}

/** Moves remove/rename/move/fork choice focus across selectable canonical sessions only. */
export function moveDashboardChooserCursor(
  state: DashboardState,
  delta: -1 | 1,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardState {
  return moveCursor(state, delta, chooserPolicy, visibleRowIds);
}

export function focusNextNeedsMe(state: DashboardState): DashboardState {
  if (state.snapshot === undefined) {
    return state;
  }
  const tree = dashboardTree(state);
  const current = state.dashboardFocus;
  if (current !== undefined && tree.visibleIndexById.has(current.rowId)) {
    const moved = moveTreeGridCursor({
      projection: tree,
      cursor: current,
      direction: "down",
      policy: needsAttentionPolicy,
    });
    if (
      !sameCursor(moved, current) &&
      exactCursor(tree, moved, needsAttentionPolicy) !== undefined
    ) {
      return focusResolvedDashboardCursor(state, tree, moved);
    }
  }
  const first = firstCursor(tree, needsAttentionPolicy);
  return first === undefined ? state : focusResolvedDashboardCursor(state, tree, first);
}

/** Returns the focused row only while chooser policy still permits committing it. */
export function focusedChooserSession(state: DashboardState): DashboardSessionRow | undefined {
  if (state.snapshot === undefined || state.dashboardFocus === undefined) {
    return undefined;
  }
  const tree = dashboardTree(state);
  const cursor = exactCursor(tree, state.dashboardFocus, chooserPolicy);
  if (cursor === undefined) {
    return undefined;
  }
  const row = tree.rowById.get(cursor.rowId);
  return row?.payload.type === "session" ? row.payload.row : undefined;
}

/** Preserves stable cell identity before collapse ancestry and positional fallback. */
export function reconcileDashboardFocus(
  previous: DashboardState,
  next: DashboardState,
): DashboardState {
  if (next.snapshot === undefined) {
    return clearDashboardFocus(next);
  }
  const nextTree = dashboardTree(next);
  const focus = previous.dashboardFocus;
  if (focus === undefined) {
    return next;
  }
  if (previous.snapshot === undefined) {
    return clearDashboardFocus(next);
  }
  const previousTree = dashboardTree(previous);
  const policy = navigationPolicy(next);
  const reconciled = reconcileTreeGridCursor({
    previous: previousTree,
    next: nextTree,
    cursor: focus,
    policy,
  });
  return reconciled === undefined
    ? clearDashboardFocus(next)
    : focusResolvedDashboardCursor(next, nextTree, reconciled);
}

export function rowNeedsYou(row: DashboardSessionRow): boolean {
  return row.presentation.display.alert;
}

function moveCursor(
  state: DashboardState,
  delta: -1 | 1,
  policy: DashboardPolicy,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardState {
  if (state.snapshot === undefined) {
    return state;
  }
  const tree = dashboardTree(state);
  const current =
    state.dashboardFocus === undefined
      ? undefined
      : exactCursor(tree, state.dashboardFocus, policy);
  if (current === undefined) {
    const entered = enterCursor(tree, delta, policy, visibleRowIds);
    return entered === undefined ? state : focusResolvedDashboardCursor(state, tree, entered);
  }
  const moved = moveTreeGridCursor({
    projection: tree,
    cursor: current,
    direction: delta < 0 ? "up" : "down",
    policy,
  });
  return sameCursor(moved, current) ? state : focusResolvedDashboardCursor(state, tree, moved);
}

function enterCursor(
  tree: DashboardTreeProjection,
  delta: -1 | 1,
  policy: DashboardPolicy,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardFocus | undefined {
  const visible = visibleRowIds === undefined ? undefined : new Set(visibleRowIds);
  const visibleRows =
    visible === undefined
      ? tree.visibleRows
      : tree.visibleRows.filter((row) => visible.has(row.id));
  const orderedRows = delta > 0 ? visibleRows : [...visibleRows].reverse();
  for (const row of orderedRows) {
    const cursor = cursorForRow(tree, row, policy);
    if (cursor !== undefined) {
      return cursor;
    }
  }
  const fallbackRows = delta > 0 ? tree.visibleRows : [...tree.visibleRows].reverse();
  for (const row of fallbackRows) {
    const cursor = cursorForRow(tree, row, policy);
    if (cursor !== undefined) {
      return cursor;
    }
  }
  return undefined;
}

function firstCursor(
  tree: DashboardTreeProjection,
  policy: DashboardPolicy,
): DashboardFocus | undefined {
  for (const row of tree.visibleRows) {
    const cursor = cursorForRow(tree, row, policy);
    if (cursor !== undefined) {
      return cursor;
    }
  }
  return undefined;
}

function cursorForRow(
  tree: DashboardTreeProjection,
  row: DashboardTreeRow,
  policy: DashboardPolicy,
): DashboardFocus | undefined {
  return treeGridCursorForRow({ projection: tree, rowId: row.id, policy });
}

function exactCursor(
  tree: DashboardTreeProjection,
  cursor: DashboardFocus,
  policy: DashboardPolicy,
): DashboardFocus | undefined {
  const resolved = treeGridCursorForRow({
    projection: tree,
    rowId: cursor.rowId,
    preferredCell: cursor.cellId,
    policy,
  });
  return resolved?.cellId === cursor.cellId ? resolved : undefined;
}

/** Applies a resolved semantic cursor; the renderer follows it using laid-out coordinates. */
export function focusResolvedDashboardCursor(
  state: DashboardState,
  tree: DashboardTreeProjection,
  cursor: DashboardFocus,
): DashboardState {
  if (!tree.visibleIndexById.has(cursor.rowId)) {
    return state;
  }
  if (sameCursor(state.dashboardFocus, cursor)) {
    return state;
  }
  return { ...state, dashboardFocus: cursor };
}

function navigationPolicy(state: DashboardState): DashboardPolicy {
  const screen = state.screen;
  return (screen.name === "removeWorktree" ||
    screen.name === "renameSession" ||
    screen.name === "fork" ||
    screen.name === "moveToGroup") &&
    screen.step === "chooseSlot"
    ? chooserPolicy
    : dashboardPolicy;
}

function dashboardTree(state: DashboardState): DashboardTreeProjection {
  if (state.snapshot === undefined) {
    throw new Error("Dashboard tree requires a snapshot.");
  }
  return selectDashboardTree(state.snapshot, state, state.screen);
}

function sameCursor(left: DashboardFocus | undefined, right: DashboardFocus | undefined): boolean {
  return left?.rowId === right?.rowId && left?.cellId === right?.cellId;
}
