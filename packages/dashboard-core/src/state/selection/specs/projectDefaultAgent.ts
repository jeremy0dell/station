import type { ProviderId } from "@station/contracts";
import { selectNewSessionHarnessChoices } from "../../../selectors/selectors.js";
import { buildSetProjectDefaultHarnessCommand } from "../../commandBuilders.js";
import type { TuiTransition } from "../../transition.js";
import type { TuiState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";

function toDashboard(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}

function commitProjectDefaultAgent(state: TuiState, harness: ProviderId): TuiTransition {
  if (state.screen.name !== "projectDefaultAgent" || state.snapshot === undefined) {
    return { state: toDashboard(state) };
  }
  const { projectId } = state.screen;
  const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || harness === project.defaults.harness) {
    return { state: toDashboard(state) };
  }
  return {
    state: toDashboard(state),
    operations: [
      {
        type: "setProjectDefaultHarness",
        command: buildSetProjectDefaultHarnessCommand({ projectId: project.id, harness }),
      },
    ],
  };
}

export const projectDefaultAgentListSpec = flatPickerSpec<ProviderId>({
  listId: "projectDefaultAgent",
  choices: (state) => {
    if (state.screen.name !== "projectDefaultAgent" || state.snapshot === undefined) {
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
  commit: commitProjectDefaultAgent,
});
