import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const projectCollapseScreenBehavior = { clickAway: closeProjectCollapse };

// Slot/↑↓/↵/mouse are handled by the shared selectionMiddleware
// (projectCollapseListSpec); only esc-to-dashboard stays bespoke.
export function handleProjectCollapseKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectCollapse") {
    return { state };
  }
  if (key.escape === true) {
    return { state: closeProjectCollapse(state) };
  }
  return { state };
}

function closeProjectCollapse(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}
