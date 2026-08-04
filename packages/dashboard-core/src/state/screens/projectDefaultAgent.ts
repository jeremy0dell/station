import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const projectDefaultAgentScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeProjectDefaultAgent,
};

export function openProjectDefaultAgentPicker(state: TuiState, projectId: string): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.health.status === "unavailable") {
    return state;
  }
  // Seed the cursor to the current default so ↑↓ starts from the highlighted
  // row and ↵ is immediately meaningful; slot-jump and mouse are unaffected.
  const selection = new Map(state.selection);
  selection.set("projectDefaultAgent", project.defaults.harness);
  return {
    ...state,
    selection,
    screen: { name: "projectDefaultAgent", projectId: project.id },
  };
}

// Selection keys (↑↓/↵/slot) are handled by the shared selectionMiddleware
// before this reducer runs; only the bespoke esc-to-dashboard chord remains.
export function handleProjectDefaultAgentKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectDefaultAgent") {
    return { state };
  }
  if (key.escape === true) {
    return { state: closeProjectDefaultAgent(state) };
  }
  return { state };
}

export function closeProjectDefaultAgent(state: TuiState): TuiState {
  // Preserve dashboardFocus beneath the picker so every safe return restores the exact header segment.
  return { ...state, screen: { name: "dashboard" } };
}
