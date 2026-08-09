import { addProjectRows } from "../../flows/addProject/rows.js";
import type { AddProjectFlowState, AddProjectFlowStateView } from "../../flows/addProject/types.js";
import type { DashboardState, DashboardStateView } from "../types.js";
import type { TuiSelectionState } from "./types.js";

export const ADD_PROJECT_START_LIST_ID = "addProjectStart";
export const ADD_PROJECT_CHOOSE_LIST_ID = "addProjectChoose";

function startChoiceId(index: number): string {
  return String(index);
}

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
    const value = selection.get(ADD_PROJECT_START_LIST_ID);
    if (value === undefined) {
      return undefined;
    }
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < flow.choices.length ? index : undefined;
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
    const currentIndex = current === undefined ? -1 : Number(current);
    const keepCurrent =
      !reset &&
      previousFlow?.mode === "start" &&
      Number.isInteger(currentIndex) &&
      currentIndex >= 0 &&
      currentIndex < flow.choices.length;
    return withSelection(
      state,
      ADD_PROJECT_START_LIST_ID,
      keepCurrent ? current : flow.choices.length === 0 ? undefined : startChoiceId(0),
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

/** Mouse selection writes the same cursor used by arrows and Enter. */
export function selectAddProjectRowByIndex(state: DashboardState, index: number): DashboardState {
  if (state.screen.name !== "addProject") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "start") {
    const selected = clampedItem(flow.choices, index);
    return selected === undefined
      ? state
      : withSelection(state, ADD_PROJECT_START_LIST_ID, startChoiceId(selected.index));
  }
  if (flow.mode === "choose") {
    const selected = clampedItem(addProjectRows(flow), index);
    return selected === undefined
      ? state
      : withSelection(state, ADD_PROJECT_CHOOSE_LIST_ID, selected.value.path);
  }
  return state;
}

function clampedItem<T>(
  items: readonly T[],
  index: number,
): { index: number; value: T } | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const clampedIndex = Math.min(items.length - 1, Math.max(0, index));
  const value = items[clampedIndex];
  return value === undefined ? undefined : { index: clampedIndex, value };
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
