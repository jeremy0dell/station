import type { ProjectId, ProviderId } from "@station/contracts";
import {
  chooseNewSessionAgentById,
  chooseNewSessionProjectById,
  createNewSessionNameToken,
} from "../../../flows/newSession.js";
import {
  selectNewSessionHarnessChoices,
  selectNewSessionProject,
  selectNewSessionProjectChoices,
} from "../../../selectors/selectors.js";
import type { TuiState } from "../../types.js";
import { flatPickerSpec } from "../flatPicker.js";

export const newSessionPickProjectListSpec = flatPickerSpec<ProjectId>({
  listId: "newSessionPickProject",
  choices: (state) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickProject" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    return selectNewSessionProjectChoices(state.snapshot).map((choice) => ({
      key: choice.key,
      value: choice.value.id,
    }));
  },
  commit: (state, projectId) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickProject" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    const flow = chooseNewSessionProjectById(
      state.screen.flow,
      state.snapshot,
      projectId,
      createNewSessionNameToken(),
    );
    return { state: { ...state, screen: { name: "newSession", flow } } };
  },
});

export const newSessionPickAgentListSpec = flatPickerSpec<ProviderId>({
  listId: "newSessionPickAgent",
  choices: (state) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickAgent" ||
      state.snapshot === undefined
    ) {
      return [];
    }
    const project = selectNewSessionProject(state.snapshot, state.screen.flow.selectedProjectId);
    if (project === undefined) {
      return [];
    }
    return selectNewSessionHarnessChoices(state.snapshot, project).map((choice) => ({
      key: choice.key,
      value: choice.value.id,
    }));
  },
  commit: (state, agentId) => {
    if (
      state.screen.name !== "newSession" ||
      state.screen.flow.mode !== "pickAgent" ||
      state.snapshot === undefined
    ) {
      return { state };
    }
    const flow = chooseNewSessionAgentById(state.screen.flow, state.snapshot, agentId);
    return { state: { ...state, screen: { name: "newSession", flow } } };
  },
});

/** Seed the pick-step cursor to the current selection when entering it. */
export function seedNewSessionPickerCursor(state: TuiState): TuiState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "pickProject") {
    const selection = new Map(state.selection);
    selection.set("newSessionPickProject", flow.selectedProjectId);
    return { ...state, selection };
  }
  if (flow.mode === "pickAgent") {
    const selection = new Map(state.selection);
    selection.set("newSessionPickAgent", flow.selectedHarness);
    return { ...state, selection };
  }
  return state;
}
