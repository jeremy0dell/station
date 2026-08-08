import type { ProjectId } from "@station/contracts";
import { selectProjectChooserChoices } from "../../../selectors/selectors.js";
import { toggleDashboardProjectCollapsed } from "../../projectHeaderActions.js";
import { openProjectSettings } from "../../screens/projectSettings.js";
import type { DashboardState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";

function projectChoices(state: DashboardState) {
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
