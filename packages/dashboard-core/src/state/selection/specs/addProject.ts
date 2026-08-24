import { addProjectRows } from "../../../flows/addProject/rows.js";
import { applyAddProjectAction } from "../../screens/addProjectTransition.js";
import { ADD_PROJECT_CHOOSE_LIST_ID, ADD_PROJECT_START_LIST_ID } from "../addProject.js";
import { defineList } from "../types.js";

export const addProjectStartListSpec = defineList({
  listId: ADD_PROJECT_START_LIST_ID,
  cursor: true,
  rows: (state) => {
    if (state.screen.name !== "addProject" || state.screen.flow.mode !== "start") {
      return [];
    }
    return state.screen.flow.choices.map((choice) => ({
      selectable: true as const,
      id: choice.path,
    }));
  },
  commit: (state, path) => {
    if (state.screen.name !== "addProject" || state.screen.flow.mode !== "start") {
      return { state };
    }
    const choice = state.screen.flow.choices.find((candidate) => candidate.path === path);
    return choice === undefined
      ? { state }
      : applyAddProjectAction(state, { type: "startOpen", path: choice.path });
  },
});

export const addProjectChooseListSpec = defineList({
  listId: ADD_PROJECT_CHOOSE_LIST_ID,
  cursor: true,
  active: (state) =>
    state.screen.name === "addProject" &&
    state.screen.flow.mode === "choose" &&
    addProjectRows(state.screen.flow).length > 0,
  rows: (state) => {
    if (state.screen.name !== "addProject" || state.screen.flow.mode !== "choose") {
      return [];
    }
    return addProjectRows(state.screen.flow).map((row) => ({
      selectable: true as const,
      id: row.path,
    }));
  },
  commit: (state, path) => {
    if (state.screen.name !== "addProject" || state.screen.flow.mode !== "choose") {
      return { state };
    }
    const selected = addProjectRows(state.screen.flow).some((row) => row.path === path);
    return selected ? applyAddProjectAction(state, { type: "chooseSelected", path }) : { state };
  },
});
