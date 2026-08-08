import { deriveTuiInputMode, type TuiInputMode } from "../keymap.js";
import type { DashboardState } from "../types.js";
import { addProjectChooseListSpec, addProjectStartListSpec } from "./specs/addProject.js";
import { newSessionPickAgentListSpec, newSessionPickProjectListSpec } from "./specs/newSession.js";
import { projectCollapseListSpec, projectSettingsPickerListSpec } from "./specs/projectChoosers.js";
import { projectDefaultAgentListSpec } from "./specs/projectDefaultAgent.js";
import { projectSettingsAgentListSpec } from "./specs/projectSettingsAgent.js";
import type { RegisteredListSpec } from "./types.js";

/**
 * Lists keyed by the input mode they own. An unregistered mode makes the
 * middleware a no-op, so a half-migrated tree runs.
 */
export const LIST_REGISTRY: Partial<Record<TuiInputMode, RegisteredListSpec>> = {
  addProjectStart: addProjectStartListSpec,
  addProjectChoose: addProjectChooseListSpec,
  addProjectFilter: addProjectChooseListSpec,
  projectDefaultAgent: projectDefaultAgentListSpec,
  newSessionPickProject: newSessionPickProjectListSpec,
  newSessionPickAgent: newSessionPickAgentListSpec,
  projectCollapse: projectCollapseListSpec,
  projectSettingsPicker: projectSettingsPickerListSpec,
  projectSettings: projectSettingsAgentListSpec,
};

export function listSpecForState(state: DashboardState): RegisteredListSpec | undefined {
  return LIST_REGISTRY[deriveTuiInputMode(state)];
}
