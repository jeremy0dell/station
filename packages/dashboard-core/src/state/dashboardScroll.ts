import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import { selectDashboardTree } from "../selectors/dashboardTree.js";
import type { DashboardState } from "./types.js";

export function scrollDashboard(state: DashboardState, delta: number): DashboardState {
  return scrollDashboardTo(state, state.scrollOffset + delta);
}

export function scrollDashboardTo(state: DashboardState, offset: number): DashboardState {
  const next = clampDashboardStateScroll({
    ...state,
    scrollOffset: offset,
  });
  if (next.scrollOffset === state.scrollOffset) {
    return state;
  }
  return next;
}

export function clampDashboardStateScroll(state: DashboardState): DashboardState {
  const scrollOffset = clampedScrollOffsetForState(state);
  if (scrollOffset === state.scrollOffset) {
    return state;
  }
  return {
    ...state,
    scrollOffset,
  };
}

function clampedScrollOffsetForState(state: DashboardState): number {
  if (state.snapshot === undefined) {
    return 0;
  }
  return clampDashboardScrollOffset({
    bodyRows: dashboardBodyRows(state.terminalRows),
    itemCount: selectDashboardTree(state.snapshot, state, state.screen).visibleRows.length,
    scrollOffset: state.scrollOffset,
  });
}
