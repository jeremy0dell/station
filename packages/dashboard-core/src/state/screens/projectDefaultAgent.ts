import {
  choiceValueByKey,
  isSelectionKey,
  selectNewSessionHarnessChoices,
} from "../../selectors/selectors.js";
import { buildSetProjectDefaultHarnessCommand } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export function openProjectDefaultAgentPicker(state: TuiState, projectId: string): TuiState {
  if (state.snapshot === undefined) {
    return state;
  }
  const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.health.status === "unavailable") {
    return state;
  }
  return {
    ...state,
    screen: { name: "projectDefaultAgent", projectId: project.id },
  };
}

export function handleProjectDefaultAgentKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectDefaultAgent") {
    return { state };
  }
  const projectId = state.screen.projectId;
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (state.snapshot === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (!isSelectionKey(key.input)) {
    return { state };
  }

  const project = state.snapshot.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  const option = choiceValueByKey(
    selectNewSessionHarnessChoices(state.snapshot, project),
    key.input,
  );
  if (option === undefined) {
    return { state };
  }
  if (option.id === project.defaults.harness) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  return {
    state: { ...state, screen: { name: "dashboard" } },
    operations: [
      {
        type: "setProjectDefaultHarness",
        command: buildSetProjectDefaultHarnessCommand({
          projectId: project.id,
          harness: option.id,
        }),
      },
    ],
  };
}
