import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

// Slot/↑↓/↵/mouse are handled by the shared selectionMiddleware
// (projectSettingsPickerListSpec); only esc-to-dashboard stays bespoke.
export function handleProjectSettingsPickerKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectSettingsPicker") {
    return { state };
  }
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  return { state };
}
