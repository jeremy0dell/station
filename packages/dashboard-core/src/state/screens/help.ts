import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const helpScreenBehavior = { clickAway: closeHelp };

export function handleHelpKey(state: TuiState, key: TuiKey): TuiTransition {
  if (key.input === "H" || key.input === "?" || key.input === "Q" || key.escape === true) {
    return {
      state: closeHelp(state),
    };
  }
  return { state };
}

function closeHelp(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}
