import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import { selectDashboardItems } from "../selectors/dashboardViewport.js";
import type { TuiState } from "./types.js";

export function scrollDashboard(state: TuiState, delta: number): TuiState {
  return clampDashboardStateScroll({
    ...state,
    scrollOffset: state.scrollOffset + delta,
  });
}

export function clampDashboardStateScroll(state: TuiState): TuiState {
  const scrollOffset = clampedScrollOffsetForState(state);
  if (scrollOffset === state.scrollOffset) {
    return state;
  }
  return {
    ...state,
    scrollOffset,
  };
}

function clampedScrollOffsetForState(state: TuiState): number {
  if (state.snapshot === undefined) {
    return 0;
  }
  return clampDashboardScrollOffset({
    bodyRows: dashboardBodyRows(state.terminalRows),
    itemCount: selectDashboardItems(state.snapshot, state).length,
    scrollOffset: state.scrollOffset,
  });
}
