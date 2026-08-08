import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import { selectDashboardItems } from "../selectors/dashboardViewport.js";
import type { DashboardState } from "./types.js";

export function scrollDashboard(state: DashboardState, delta: number): DashboardState {
  return clampDashboardStateScroll({
    ...state,
    scrollOffset: state.scrollOffset + delta,
  });
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
    itemCount: selectDashboardItems(state.snapshot, state).length,
    scrollOffset: state.scrollOffset,
  });
}
