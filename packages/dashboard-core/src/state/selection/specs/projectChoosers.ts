import type { ProjectId } from "@station/contracts";
import { selectProjectChooserChoices } from "../../../selectors/selectors.js";
import { clampDashboardStateScroll } from "../../dashboardScroll.js";
import { openProjectSettings } from "../../screens/projectSettings.js";
import type { TuiState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";

function projectChoices(state: TuiState) {
  if (state.snapshot === undefined) {
    return [];
  }
  return selectProjectChooserChoices(state.snapshot).map((choice) => ({
    key: choice.key,
    value: choice.value.id,
  }));
}

export const projectCollapseListSpec = flatPickerSpec<ProjectId>({
  listId: "projectCollapse",
  choices: projectChoices,
  commit: (state, projectId) => {
    const collapsedProjectIds = new Set(state.collapsedProjectIds);
    if (collapsedProjectIds.has(projectId)) {
      collapsedProjectIds.delete(projectId);
    } else {
      collapsedProjectIds.add(projectId);
    }
    return {
      state: clampDashboardStateScroll({
        ...state,
        collapsedProjectIds,
        screen: { name: "dashboard" },
      }),
    };
  },
});

export const projectSettingsPickerListSpec = flatPickerSpec<ProjectId>({
  listId: "projectSettingsPicker",
  choices: projectChoices,
  commit: (state, projectId) => ({ state: openProjectSettings(state, projectId) }),
});
