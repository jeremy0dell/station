import type { ProviderId } from "@station/contracts";
import { selectNewSessionHarnessChoices } from "../../../selectors/selectors.js";
import {
  commitProjectSettingsAgentById,
  PROJECT_SETTINGS_AGENT_LIST_ID,
} from "../../screens/projectSettings.js";
import { flatPickerSpec } from "../flatPicker.js";

/**
 * The default-agent enum inside the two-pane Project Settings panel, hosted as an
 * engine leaf. `active` gates it to the descended agent detail so ↑↓/↵/slot only
 * act there; the list, remove detail, and the destructive disarm stay bespoke in
 * the reducer. Commit routes through the same optimistic path as the slot/click.
 */
export const projectSettingsAgentListSpec = flatPickerSpec<ProviderId>({
  listId: PROJECT_SETTINGS_AGENT_LIST_ID,
  active: (state) =>
    state.screen.name === "projectSettings" &&
    state.screen.focus === "detail" &&
    state.screen.activeId === "agent",
  choices: (state) => {
    if (state.screen.name !== "projectSettings" || state.snapshot === undefined) {
      return [];
    }
    const { projectId } = state.screen;
    const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return [];
    }
    return selectNewSessionHarnessChoices(state.snapshot, project).map((choice) => ({
      key: choice.key,
      value: choice.value.id,
    }));
  },
  commit: (state, harness) => commitProjectSettingsAgentById(state, harness),
});
