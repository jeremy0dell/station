import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

// Slot/↑↓/↵/mouse are handled by the shared selectionMiddleware
// (projectCollapseListSpec); only esc-to-dashboard stays bespoke.
export function handleProjectCollapseKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectCollapse") {
    return { state };
  }
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  return { state };
}
