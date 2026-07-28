import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const projectSettingsPickerScreenBehavior = { clickAway: closeProjectSettingsPicker };

// Slot/↑↓/↵/mouse are handled by the shared selectionMiddleware
// (projectSettingsPickerListSpec); only esc-to-dashboard stays bespoke.
export function handleProjectSettingsPickerKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectSettingsPicker") {
    return { state };
  }
  if (key.escape === true) {
    return { state: closeProjectSettingsPicker(state) };
  }
  return { state };
}

function closeProjectSettingsPicker(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}
