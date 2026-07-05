import {
  commitProjectSettingsAgentById,
  PROJECT_SETTINGS_AGENT_LIST_ID,
} from "../../screens/projectSettings.js";
import { harnessPickerSpec } from "./harnessPicker.js";

/**
 * The default-agent enum inside the two-pane Project Settings panel, hosted as an
 * engine leaf. `active` gates it to the descended agent detail so ↑↓/↵/slot only
 * act there; the list, remove detail, and the destructive disarm stay bespoke in
 * the reducer. Commit routes through the same optimistic path as the slot/click.
 */
export const projectSettingsAgentListSpec = harnessPickerSpec({
  listId: PROJECT_SETTINGS_AGENT_LIST_ID,
  active: (state) =>
    state.screen.name === "projectSettings" &&
    state.screen.focus === "detail" &&
    state.screen.activeId === "agent",
  resolveProject: (snapshot, state) => {
    if (state.screen.name !== "projectSettings") {
      return undefined;
    }
    const { projectId } = state.screen;
    return snapshot.projects.find((candidate) => candidate.id === projectId);
  },
  commit: commitProjectSettingsAgentById,
});
