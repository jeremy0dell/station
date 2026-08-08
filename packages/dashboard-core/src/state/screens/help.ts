import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

export const helpScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeHelp,
};

export function handleHelpKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (key.input === "H" || key.input === "?" || key.input === "Q" || key.escape === true) {
    return {
      state: closeHelp(state),
    };
  }
  return { state };
}

function closeHelp(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}
