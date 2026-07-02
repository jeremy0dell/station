import type { WorktreeRow } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import {
  type DashboardViewportItem,
  selectDashboardItems,
} from "../selectors/dashboardViewport.js";
import { scrollDashboard } from "./dashboardScroll.js";
import { activateDashboardRow } from "./rowActivation.js";
import type { TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

type WorktreeItem = Extract<DashboardViewportItem, { type: "worktree" }>;

// Cursor rule (D9): the cursor is where you are — ↑↓/⇥ move it and the viewport
// follows; jump keys and mouse clicks still teleport-and-activate directly.
export function moveDashboardFocus(state: TuiState, delta: -1 | 1): TuiState {
  if (state.snapshot === undefined) {
    return scrollDashboard(state, delta);
  }
  const items = selectDashboardItems(state.snapshot, state);
  const focusable = focusableIndexes(items);
  if (focusable.length === 0) {
    // No session rows (e.g. all projects empty) — arrows fall back to scrolling.
    return scrollDashboard(state, delta);
  }
  const current = focusedItemIndex(items, state);
  if (current === undefined) {
    return focusItem(state, items, enterFocusIndex(state, items, focusable, delta));
  }
  const position = focusable.indexOf(current);
  const next = focusable[position + delta] ?? current;
  return focusItem(state, items, next);
}

export function focusNextNeedsMe(state: TuiState): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const candidates = focusableIndexes(items).filter((index) => {
    const item = items[index] as WorktreeItem;
    return rowNeedsYou(item.row);
  });
  if (candidates.length === 0) {
    return state;
  }
  const current = focusedItemIndex(items, state) ?? -1;
  const next = candidates.find((index) => index > current) ?? candidates[0];
  return next === undefined ? state : focusItem(state, items, next);
}

export function activateFocusedDashboardRow(state: TuiState): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = focusedItemIndex(items, state);
  const item = index === undefined ? undefined : (items[index] as WorktreeItem);
  // Pending rows mirror the slot-key rule: no activation while an operation is
  // already in flight for the row.
  if (item === undefined || item.pendingRemove !== undefined || item.pendingStart !== undefined) {
    return { state };
  }
  return activateDashboardRow(state, item.row);
}

export function rowNeedsYou(row: WorktreeRow): boolean {
  return row.agent?.state === "needs_attention" || row.agent?.state === "stuck";
}

function focusableIndexes(items: readonly DashboardViewportItem[]): number[] {
  return items.flatMap((item, index) => (item.type === "worktree" ? [index] : []));
}

function focusedItemIndex(
  items: readonly DashboardViewportItem[],
  state: TuiState,
): number | undefined {
  if (state.focusedRowId === undefined) {
    return undefined;
  }
  const index = items.findIndex(
    (item) => item.type === "worktree" && item.row.id === state.focusedRowId,
  );
  return index === -1 ? undefined : index;
}

// With no cursor yet (or a stale one), enter the list where the user is
// looking: the first/last session row inside the current viewport.
function enterFocusIndex(
  state: TuiState,
  items: readonly DashboardViewportItem[],
  focusable: readonly number[],
  delta: -1 | 1,
): number {
  const { bodyRows, offset } = viewportWindow(state, items.length);
  const visible = focusable.filter((index) => index >= offset && index < offset + bodyRows);
  const fallback = delta > 0 ? focusable[0] : focusable[focusable.length - 1];
  const entered = delta > 0 ? visible[0] : visible[visible.length - 1];
  return entered ?? fallback ?? 0;
}

function focusItem(
  state: TuiState,
  items: readonly DashboardViewportItem[],
  index: number,
): TuiState {
  const item = items[index];
  if (item === undefined || item.type !== "worktree") {
    return { ...state };
  }
  const { bodyRows, offset } = viewportWindow(state, items.length);
  let scrollOffset = offset;
  if (index < offset) {
    scrollOffset = index;
  } else if (index >= offset + bodyRows) {
    scrollOffset = index - bodyRows + 1;
  }
  return { ...state, focusedRowId: item.row.id, scrollOffset };
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
