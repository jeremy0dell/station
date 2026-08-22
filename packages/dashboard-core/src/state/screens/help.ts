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

/** Opens Help while retaining an active dashboard shortcut draft for the return path. */
export function openHelp(state: DashboardState): DashboardState {
  if (state.screen.name === "dashboard" && state.screen.shortcutCodeInput !== undefined) {
    return {
      ...state,
      screen: {
        name: "help",
        returnTo: {
          name: "dashboard",
          shortcutCodeInput: state.screen.shortcutCodeInput,
        },
      },
    };
  }
  return { ...state, screen: { name: "help" } };
}

function closeHelp(state: DashboardState): DashboardState {
  return {
    ...state,
    screen:
      state.screen.name === "help" && state.screen.returnTo !== undefined
        ? state.screen.returnTo
        : { name: "dashboard" },
  };
}
