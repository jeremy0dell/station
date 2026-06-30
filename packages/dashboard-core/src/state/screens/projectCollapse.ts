import { clampDashboardStateScroll } from "../dashboardScroll.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { handleProjectSlotPickerKey } from "./projectSlotPicker.js";

export function handleProjectCollapseKey(state: TuiState, key: TuiKey): TuiTransition {
  return handleProjectSlotPickerKey(state, key, "projectCollapse", (current, project) => {
    const collapsedProjectIds = new Set(current.collapsedProjectIds);
    if (collapsedProjectIds.has(project.id)) {
      collapsedProjectIds.delete(project.id);
    } else {
      collapsedProjectIds.add(project.id);
    }
    return {
      state: clampDashboardStateScroll({
        ...current,
        collapsedProjectIds,
        screen: { name: "dashboard" },
      }),
    };
  });
}
