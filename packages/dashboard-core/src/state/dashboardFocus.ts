import type { ProjectId, SessionId } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import {
  type DashboardViewportItem,
  selectDashboardItems,
} from "../selectors/dashboardViewport.js";
import type { DashboardSessionRow } from "../selectors/selectors.js";
import { scrollDashboard } from "./dashboardScroll.js";
import { activateDashboardRow } from "./rowActivation.js";
import type { TuiTransition } from "./transition.js";
import type { DashboardFocus, ProjectHeaderControl, TuiState } from "./types.js";

type SessionItem = Extract<DashboardViewportItem, { type: "session" }>;
type ProjectHeaderItem = Extract<DashboardViewportItem, { type: "projectHeader" }>;
type EmptyProjectItem = Extract<DashboardViewportItem, { type: "emptyProject" }>;
type FocusableItem = SessionItem | ProjectHeaderItem | EmptyProjectItem;

const PROJECT_HEADER_CONTROLS: readonly ProjectHeaderControl[] = [
  "primary",
  "shell",
  "quickSession",
  "defaultAgent",
];

/** Focuses the visible dashboard row for a canonical session identity. */
export function focusDashboardSession(state: TuiState, sessionId: SessionId): TuiState {
  if (state.snapshot === undefined) {
    return clearDashboardFocus(state);
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = items.findIndex((item) => item.type === "session" && item.row.id === sessionId);
  return index === -1
    ? clearDashboardFocus(state)
    : focusItem(state, items, index, { kind: "session", sessionId });
}

/** Focuses one control on a currently visible project header. */
export function focusDashboardProjectHeader(
  state: TuiState,
  projectId: ProjectId,
  control: ProjectHeaderControl,
): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = items.findIndex(
    (item) => item.type === "projectHeader" && item.project.id === projectId,
  );
  return index === -1
    ? state
    : focusItem(state, items, index, { kind: "projectHeader", projectId, control });
}

/** Focuses the stable action rendered for a currently empty project. */
export function focusDashboardEmptyProjectAction(state: TuiState, projectId: ProjectId): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = items.findIndex(
    (item) => item.type === "emptyProject" && item.project.id === projectId,
  );
  return index === -1
    ? state
    : focusItem(state, items, index, { kind: "emptyProjectAction", projectId });
}

/** Removes transient dashboard focus without disturbing other view state. */
export function clearDashboardFocus(state: TuiState): TuiState {
  const cleared = { ...state };
  delete cleared.dashboardFocus;
  return cleared;
}

// Vertical dashboard traversal includes project headers and empty-project actions, while row
// chooser traversal deliberately uses moveDashboardSessionFocus to remain session-only.
export function moveDashboardFocus(state: TuiState, delta: -1 | 1): TuiState {
  return moveFocus(state, delta, "dashboard");
}

/** Moves remove/rename/fork choice focus across sessions without visiting headers. */
export function moveDashboardSessionFocus(state: TuiState, delta: -1 | 1): TuiState {
  return moveFocus(state, delta, "session");
}

/** Moves within a focused project header, clamping at both ends without wrapping. */
export function moveDashboardFocusHorizontal(state: TuiState, delta: -1 | 1): TuiState {
  const focus = state.dashboardFocus;
  if (focus?.kind !== "projectHeader" || state.snapshot === undefined) {
    return state;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = focusedItemIndex(items, focus);
  if (index === undefined) {
    return state;
  }
  const position = PROJECT_HEADER_CONTROLS.indexOf(focus.control);
  const nextPosition = Math.min(PROJECT_HEADER_CONTROLS.length - 1, Math.max(0, position + delta));
  const control = PROJECT_HEADER_CONTROLS[nextPosition];
  if (control === undefined || control === focus.control) {
    return state;
  }
  return focusItem(state, items, index, { ...focus, control });
}

export function focusNextNeedsMe(state: TuiState): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const candidates = focusableIndexes(items, "session").filter((index) => {
    const item = items[index] as SessionItem;
    return rowNeedsYou(item.row);
  });
  if (candidates.length === 0) {
    return state;
  }
  const current = focusedItemIndex(items, state.dashboardFocus) ?? -1;
  const next = candidates.find((index) => index > current) ?? candidates[0];
  return next === undefined ? state : focusItem(state, items, next);
}

export function activateFocusedDashboardRow(state: TuiState): TuiTransition {
  const row = focusedSelectableRow(state);
  return row === undefined ? { state } : activateDashboardRow(state, row);
}

/** Returns the focused visible project-header identity for activation. */
export function focusedProjectHeaderControl(
  state: TuiState,
): Extract<DashboardFocus, { kind: "projectHeader" }> | undefined {
  const focus = state.dashboardFocus;
  if (focus?.kind !== "projectHeader" || state.snapshot === undefined) {
    return undefined;
  }
  const items = selectDashboardItems(state.snapshot, state);
  return focusedItemIndex(items, focus) === undefined ? undefined : focus;
}

/** Returns the focused empty-project action only while its row remains rendered. */
export function focusedEmptyProjectAction(
  state: TuiState,
): Extract<DashboardFocus, { kind: "emptyProjectAction" }> | undefined {
  const focus = state.dashboardFocus;
  if (focus?.kind !== "emptyProjectAction" || state.snapshot === undefined) {
    return undefined;
  }
  const items = selectDashboardItems(state.snapshot, state);
  return focusedItemIndex(items, focus) === undefined ? undefined : focus;
}

/**
 * The focused row only when it is currently committable: present in the filtered
 * view (not collapsed or searched away) and not mid-operation. The choose-row
 * trio's ↵ resolves through this so it cannot act on a row the slot path and
 * dashboard activation both refuse.
 */
export function focusedSelectableRow(state: TuiState): DashboardSessionRow | undefined {
  if (state.snapshot === undefined || state.dashboardFocus?.kind !== "session") {
    return undefined;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = focusedItemIndex(items, state.dashboardFocus);
  const item = index === undefined ? undefined : items[index];
  if (
    item?.type !== "session" ||
    item.pendingRemove !== undefined ||
    item.pendingStart !== undefined
  ) {
    return undefined;
  }
  return item.row;
}

/**
 * Preserves stable focus across dashboard list-shape changes, then falls forward
 * from the old item position before falling back to the preceding focusable item.
 */
export function reconcileDashboardFocus(previous: TuiState, next: TuiState): TuiState {
  if (next.snapshot === undefined) {
    return clearDashboardFocus(withClampedScroll(next, 0));
  }
  const nextItems = selectDashboardItems(next.snapshot, next);
  const nextFocusable = focusableIndexes(nextItems, "dashboard");
  if (!hasFocusableIndexes(nextFocusable)) {
    return clearDashboardFocus(withClampedScroll(next, nextItems.length));
  }

  const focus = previous.dashboardFocus;
  if (focus === undefined) {
    return withClampedScroll(next, nextItems.length);
  }
  const retainedIndex = focusedItemIndex(nextItems, focus);
  if (retainedIndex !== undefined) {
    return focusItem(next, nextItems, retainedIndex, focus);
  }

  const previousItems =
    previous.snapshot === undefined ? [] : selectDashboardItems(previous.snapshot, previous);
  const previousIndex = focusedItemIndex(previousItems, focus);
  if (previousIndex === undefined) {
    return clearDashboardFocus(withClampedScroll(next, nextItems.length));
  }
  const following = nextFocusable.find((index) => index >= previousIndex);
  return focusItem(next, nextItems, following ?? lastFocusableIndex(nextFocusable));
}

export function rowNeedsYou(row: DashboardSessionRow): boolean {
  return row.session.status.value === "needs_attention" || row.session.status.value === "stuck";
}

function moveFocus(state: TuiState, delta: -1 | 1, mode: "dashboard" | "session"): TuiState {
  if (state.snapshot === undefined) {
    return scrollDashboard(state, delta);
  }
  const items = selectDashboardItems(state.snapshot, state);
  const focusable = focusableIndexes(items, mode);
  if (!hasFocusableIndexes(focusable)) {
    return scrollDashboard(state, delta);
  }
  const current = focusedItemIndex(items, state.dashboardFocus);
  if (current === undefined) {
    return focusItem(state, items, enterFocusIndex(state, items, focusable, delta));
  }
  const currentPosition = focusable.indexOf(current);
  if (currentPosition === -1) {
    return focusItem(state, items, enterFocusIndex(state, items, focusable, delta));
  }
  const next = focusable[currentPosition + delta] ?? current;
  return next === current ? state : focusItem(state, items, next);
}

function focusableIndexes(
  items: readonly DashboardViewportItem[],
  mode: "dashboard" | "session",
): number[] {
  return items.flatMap((item, index) =>
    item.type === "session" ||
    (mode === "dashboard" && (item.type === "projectHeader" || item.type === "emptyProject"))
      ? [index]
      : [],
  );
}

function focusedItemIndex(
  items: readonly DashboardViewportItem[],
  focus: DashboardFocus | undefined,
): number | undefined {
  if (focus === undefined) {
    return undefined;
  }
  const index = items.findIndex((item) => focusMatchesItem(focus, item));
  return index === -1 ? undefined : index;
}

function focusMatchesItem(focus: DashboardFocus, item: DashboardViewportItem): boolean {
  switch (focus.kind) {
    case "session":
      return item.type === "session" && item.row.id === focus.sessionId;
    case "projectHeader":
      return item.type === "projectHeader" && item.project.id === focus.projectId;
    case "emptyProjectAction":
      return item.type === "emptyProject" && item.project.id === focus.projectId;
  }
}

// With no cursor yet (or a stale one), enter where the user is looking: the
// first/last focusable item inside the current viewport.
function enterFocusIndex(
  state: TuiState,
  items: readonly DashboardViewportItem[],
  focusable: readonly [number, ...number[]],
  delta: -1 | 1,
): number {
  const { bodyRows, offset } = viewportWindow(state, items.length);
  const visible = focusable.filter((index) => index >= offset && index < offset + bodyRows);
  const fallback = delta > 0 ? focusable[0] : lastFocusableIndex(focusable);
  const entered = delta > 0 ? visible[0] : visible.at(-1);
  return entered ?? fallback;
}

function hasFocusableIndexes(
  indexes: readonly number[],
): indexes is readonly [number, ...number[]] {
  return indexes.length > 0;
}

function lastFocusableIndex(indexes: readonly [number, ...number[]]): number {
  let last = indexes[0];
  for (const index of indexes) {
    last = index;
  }
  return last;
}

function focusItem(
  state: TuiState,
  items: readonly DashboardViewportItem[],
  index: number,
  focus?: DashboardFocus,
): TuiState {
  const item = items[index];
  if (
    item === undefined ||
    (item.type !== "session" && item.type !== "projectHeader" && item.type !== "emptyProject")
  ) {
    return state;
  }
  const { bodyRows, offset } = viewportWindow(state, items.length);
  let scrollOffset = offset;
  if (index < offset) {
    scrollOffset = index;
  } else if (index >= offset + bodyRows) {
    scrollOffset = index - bodyRows + 1;
  }
  return {
    ...state,
    dashboardFocus: focus ?? focusForItem(item),
    scrollOffset,
  };
}

function focusForItem(item: FocusableItem): DashboardFocus {
  switch (item.type) {
    case "session":
      return { kind: "session", sessionId: item.row.id };
    case "projectHeader":
      return { kind: "projectHeader", projectId: item.project.id, control: "primary" };
    case "emptyProject":
      return { kind: "emptyProjectAction", projectId: item.project.id };
  }
}

function withClampedScroll(state: TuiState, itemCount: number): TuiState {
  const { offset } = viewportWindow(state, itemCount);
  return offset === state.scrollOffset ? state : { ...state, scrollOffset: offset };
}

function viewportWindow(state: TuiState, itemCount: number): { bodyRows: number; offset: number } {
  const bodyRows = dashboardBodyRows(state.terminalRows);
  return {
    bodyRows,
    offset: clampDashboardScrollOffset({
      bodyRows,
      itemCount,
      scrollOffset: state.scrollOffset,
    }),
  };
}
