import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { openProjectSettings } from "./projectSettings.js";
import { handleProjectSlotPickerKey } from "./projectSlotPicker.js";

/**
 * Slot-key project chooser reached by `P`. Mirrors projectCollapse: esc backs
 * out to the dashboard, a slot key resolves the project and drops straight into
 * its settings panel via the shared openProjectSettings transition.
 */
export function handleProjectSettingsPickerKey(state: TuiState, key: TuiKey): TuiTransition {
  return handleProjectSlotPickerKey(state, key, "projectSettingsPicker", (current, project) => ({
    state: openProjectSettings(current, project.id),
  }));
}
