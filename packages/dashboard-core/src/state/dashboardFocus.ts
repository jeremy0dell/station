import type { SessionId } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import {
  type DashboardViewportItem,
  selectDashboardItems,
} from "../selectors/dashboardViewport.js";
import type { DashboardSessionRow } from "../selectors/selectors.js";
import { scrollDashboard } from "./dashboardScroll.js";
import { activateDashboardRow } from "./rowActivation.js";
import type { TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

type SessionItem = Extract<DashboardViewportItem, { type: "session" }>;

/** Focuses the visible dashboard row for a canonical session identity. */
export function focusDashboardSession(state: TuiState, sessionId: SessionId): TuiState {
  if (state.snapshot === undefined) {
    return clearDashboardFocus(state);
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = items.findIndex((item) => item.type === "session" && item.row.id === sessionId);
  return index === -1 ? clearDashboardFocus(state) : focusItem(state, items, index);
}

/** Removes transient dashboard row focus without disturbing other view state. */
export function clearDashboardFocus(state: TuiState): TuiState {
  const cleared = { ...state };
  delete cleared.focusedRowId;
  return cleared;
}

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
    const item = items[index] as SessionItem;
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
  const row = focusedSelectableRow(state);
  return row === undefined ? { state } : activateDashboardRow(state, row);
}

/**
 * The focused row only when it is currently committable: present in the filtered
 * view (not collapsed or searched away) and not mid-operation. The choose-row
 * trio's ↵ resolves through this so it cannot act on a row the slot path and
 * dashboard activation both refuse — a pending row, or one filtered out of the
 * view (viewport scroll does not unfocus; the cursor rule keeps it committable).
 */
export function focusedSelectableRow(state: TuiState): DashboardSessionRow | undefined {
  if (state.snapshot === undefined) {
    return undefined;
  }
  const items = selectDashboardItems(state.snapshot, state);
  const index = focusedItemIndex(items, state);
  const item = index === undefined ? undefined : (items[index] as SessionItem);
  if (item === undefined || item.pendingRemove !== undefined || item.pendingStart !== undefined) {
    return undefined;
  }
  return item.row;
}

export function rowNeedsYou(row: DashboardSessionRow): boolean {
  return row.session.status.value === "needs_attention" || row.session.status.value === "stuck";
}

function focusableIndexes(items: readonly DashboardViewportItem[]): number[] {
  return items.flatMap((item, index) => (item.type === "session" ? [index] : []));
}

function focusedItemIndex(
  items: readonly DashboardViewportItem[],
  state: TuiState,
): number | undefined {
  if (state.focusedRowId === undefined) {
    return undefined;
  }
  const index = items.findIndex(
    (item) => item.type === "session" && item.row.id === state.focusedRowId,
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
  if (item === undefined || item.type !== "session") {
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
