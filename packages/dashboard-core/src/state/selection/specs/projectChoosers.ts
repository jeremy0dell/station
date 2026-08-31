import type { ProjectId } from "@station/contracts";
import { selectProjectChooserChoices } from "../../../selectors/projectChoices.js";
import { toggleDashboardProjectCollapsed } from "../../screens/projectCollapse.js";
import { openProjectSettings } from "../../screens/projectSettings.js";
import type { DashboardState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";

function projectChoices(state: DashboardState) {
  if (state.snapshot === undefined) {
    return [];
  }
  return selectProjectChooserChoices(state.snapshot).map((choice) => {
    const mapped = { value: choice.value.id };
    return choice.key === undefined ? mapped : { ...mapped, key: choice.key };
  });
}

export const projectCollapseListSpec = flatPickerSpec<ProjectId>({
  listId: "projectCollapse",
  choices: projectChoices,
  commit: (state, projectId) => ({
    state: {
      ...toggleDashboardProjectCollapsed(state, projectId),
      screen: { name: "dashboard" },
    },
  }),
});

export const projectSettingsPickerListSpec = flatPickerSpec<ProjectId>({
  listId: "projectSettingsPicker",
  choices: projectChoices,
  commit: (state, projectId) => ({ state: openProjectSettings(state, projectId) }),
});
