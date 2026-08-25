import { addProjectRows } from "../../flows/addProject/rows.js";
import type { AddProjectFlowState, AddProjectFlowStateView } from "../../flows/addProject/types.js";
import type { DashboardState, DashboardStateView } from "../types.js";
import type { TuiSelectionState } from "./types.js";

export const ADD_PROJECT_START_LIST_ID = "addProjectStart";
export const ADD_PROJECT_CHOOSE_LIST_ID = "addProjectChoose";

export function addProjectSelectedIndex(state: DashboardStateView): number | undefined {
  return state.screen.name === "addProject"
    ? addProjectSelectedIndexForFlow(state.screen.flow, state.selection)
    : undefined;
}

export function addProjectSelectedIndexForFlow(
  flow: AddProjectFlowStateView,
  selection: TuiSelectionState,
): number | undefined {
  if (flow.mode === "start") {
    const itemId = selection.get(ADD_PROJECT_START_LIST_ID);
    if (itemId === undefined) return undefined;
    const index = flow.choices.findIndex((choice) => choice.id === itemId);
    return index < 0 ? undefined : index;
  }
  if (flow.mode === "choose") {
    const path = selection.get(ADD_PROJECT_CHOOSE_LIST_ID);
    if (path === undefined) {
      return undefined;
    }
    const index = addProjectRows(flow).findIndex((row) => row.path === path);
    return index < 0 ? undefined : index;
  }
  return undefined;
}

export function selectedAddProjectFolderRow(state: DashboardStateView) {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "choose") {
    return undefined;
  }
  const index = addProjectSelectedIndex(state);
  return index === undefined ? undefined : addProjectRows(state.screen.flow)[index];
}

/**
 * Reconcile only start/folder list selection; review and terminal-state action focus is flow-owned.
 */
export function reconcileAddProjectSelection(
  state: DashboardState,
  previousFlow: AddProjectFlowState | undefined,
  reset: boolean,
): DashboardState {
  if (state.screen.name !== "addProject") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "start") {
    const current = state.selection.get(ADD_PROJECT_START_LIST_ID);
    const keepCurrent =
      !reset &&
      previousFlow?.mode === "start" &&
      flow.choices.some((choice) => choice.id === current);
    return withSelection(
      state,
      ADD_PROJECT_START_LIST_ID,
      keepCurrent ? current : flow.choices[0]?.id,
    );
  }
  if (flow.mode === "choose") {
    const rows = addProjectRows(flow);
    const current = state.selection.get(ADD_PROJECT_CHOOSE_LIST_ID);
    const sameFolder =
      previousFlow?.mode === "choose" && previousFlow.currentPath === flow.currentPath;
    const keepCurrent = !reset && sameFolder && rows.some((row) => row.path === current);
    return withSelection(state, ADD_PROJECT_CHOOSE_LIST_ID, keepCurrent ? current : rows[0]?.path);
  }
  return state;
}

/** Pointer selection writes the stable semantic identity used by arrows and Enter. */
export function selectAddProjectRowById(state: DashboardState, itemId: string): DashboardState {
  if (state.screen.name !== "addProject") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "start") {
    const selected = flow.choices.find((choice) => choice.id === itemId);
    return selected === undefined
      ? state
      : withSelection(state, ADD_PROJECT_START_LIST_ID, selected.id);
  }
  if (flow.mode === "choose") {
    const selected = addProjectRows(flow).find((row) => row.path === itemId);
    return selected === undefined
      ? state
      : withSelection(state, ADD_PROJECT_CHOOSE_LIST_ID, selected.path);
  }
  return state;
}

function withSelection(
  state: DashboardState,
  listId: string,
  id: string | undefined,
): DashboardState {
  if (id === undefined && !state.selection.has(listId)) {
    return state;
  }
  if (id !== undefined && state.selection.get(listId) === id) {
    return state;
  }
  const selection = new Map(state.selection);
  if (id === undefined) {
    selection.delete(listId);
  } else {
    selection.set(listId, id);
  }
  return { ...state, selection };
}
