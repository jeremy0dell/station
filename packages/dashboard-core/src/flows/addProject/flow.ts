import {
  createEditableTextInputState,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { normalizedFilter, searchQueryForFilter } from "./input.js";
import {
  chooseStateForLoadedFolder,
  commitEditedProjectId,
  createAddProjectStartState,
  failedStateForError,
  reviewStateForFolder,
  reviewWithoutEditingId,
  successStateForProject,
  withoutSearchError,
} from "./state.js";
import type {
  AddProjectEditIdActionFocus,
  AddProjectFailedActionFocus,
  AddProjectFlowAction,
  AddProjectFlowState,
  AddProjectReviewActionFocus,
  AddProjectTransition,
  CreateAddProjectFlowInput,
} from "./types.js";

const REVIEW_ACTIONS: readonly AddProjectReviewActionFocus[] = [
  "submit",
  "editId",
  "chooseFolder",
  "cancel",
];
const EDIT_ID_ACTIONS: readonly AddProjectEditIdActionFocus[] = ["save", "back"];
const FAILED_ACTIONS: readonly AddProjectFailedActionFocus[] = ["retry", "chooseFolder", "cancel"];

export function createAddProjectFlow(input: CreateAddProjectFlowInput) {
  return createAddProjectStartState(input);
}

export function transitionAddProjectFlow(
  state: AddProjectFlowState,
  action: AddProjectFlowAction,
  parentPath?: (path: string) => string,
): AddProjectTransition {
  switch (action.type) {
    case "startOpen":
      return state.mode === "start"
        ? { state, effects: [{ type: "loadDirectory", path: action.path }] }
        : { state };
    case "chooseOpen":
      return state.mode === "choose"
        ? { state, effects: [{ type: "loadDirectory", path: action.path }] }
        : { state };
    case "chooseParent":
      return state.mode === "choose"
        ? {
            state,
            effects: [
              { type: "loadDirectory", path: parentPath?.(state.currentPath) ?? state.currentPath },
            ],
          }
        : { state };
    case "chooseSelected":
      return state.mode === "choose"
        ? { state, effects: [{ type: "reviewFolder", path: action.path }] }
        : { state };
    case "folderLoaded":
      return {
        state: chooseStateForLoadedFolder(state, action.result.path, action.result.entries),
      };
    case "folderLoadFailed":
      return {
        state: chooseStateForLoadedFolder(state, action.path, [], { error: action.error }),
      };
    case "folderSearchLoaded":
      return state.mode === "choose" && action.result.query === normalizedFilter(state.filter)
        ? {
            state: withoutSearchError({
              ...state,
              searchEntries: action.result.entries,
              searching: false,
              searchTruncated: action.result.truncated,
            }),
          }
        : { state };
    case "folderSearchFailed":
      return state.mode === "choose" && action.query === normalizedFilter(state.filter)
        ? {
            state: {
              ...state,
              searchEntries: [],
              searching: false,
              searchTruncated: false,
              searchError: action.error,
            },
          }
        : { state };
    case "folderReviewed":
      return { state: reviewStateForFolder(state, action.review) };
    case "folderReviewFailed":
      return { state: failedStateForError(state, action.path, action.error) };
    case "filterStart":
      return state.mode === "choose" ? { state: { ...state, filterMode: true } } : { state };
    case "filterInput":
      return updateFilter(state, `${state.mode === "choose" ? state.filter : ""}${action.value}`);
    case "filterBackspace":
      return updateFilter(state, state.mode === "choose" ? state.filter.slice(0, -1) : "");
    case "filterClear":
      return state.mode === "choose"
        ? {
            state: withoutSearchError({
              ...state,
              filter: "",
              filterMode: false,
              searchEntries: [],
              searching: false,
              searchTruncated: false,
            }),
          }
        : { state };
    case "submit":
      return submitReview(state);
    case "submitted":
      return { state: successStateForProject(state, action.label, action.root) };
    case "submitFailed":
      return state.mode === "review"
        ? { state: failedStateForError(state, state.selectedPath, action.error) }
        : { state };
    case "editIdStart":
      return state.mode === "review" && !state.submitting
        ? {
            state: {
              ...state,
              actionFocus: "editId",
              editingId: createEditableTextInputState(state.id),
              editIdActionFocus: "save",
            },
          }
        : { state };
    case "editIdInput":
      return state.mode === "review" && state.editingId !== undefined
        ? {
            state: {
              ...state,
              editingId: transitionEditableTextInput(state.editingId, action.action),
            },
          }
        : { state };
    case "editIdCommit":
      return state.mode === "review" && state.editingId !== undefined
        ? { state: commitEditedProjectId(state) }
        : { state };
    case "editIdCancel":
      return state.mode === "review" && state.editingId !== undefined
        ? { state: reviewWithoutEditingId(state) }
        : { state };
    case "actionFocus":
      return { state: moveActionFocus(state, action.dir) };
    case "backToChoose":
      return state.mode === "review" || state.mode === "failed"
        ? { state, effects: [{ type: "loadDirectory", path: state.selectedPath }] }
        : { state };
  }
}

function submitReview(state: AddProjectFlowState): AddProjectTransition {
  if (
    state.mode !== "review" ||
    state.editingId !== undefined ||
    state.gitRoot === undefined ||
    state.submitting
  ) {
    return { state };
  }
  return {
    state: { ...state, submitting: true },
    effects: [
      {
        type: "submitProject",
        command: {
          type: "project.add",
          payload: {
            path: state.selectedPath,
            id: state.id,
            label: state.label,
          },
        },
      },
    ],
  };
}

function moveActionFocus(state: AddProjectFlowState, dir: -1 | 1): AddProjectFlowState {
  if (state.mode === "review") {
    if (state.submitting) {
      return state;
    }
    if (state.editingId !== undefined) {
      return {
        ...state,
        editIdActionFocus: cycleAction(EDIT_ID_ACTIONS, state.editIdActionFocus ?? "save", dir),
      };
    }
    const enabled = REVIEW_ACTIONS.filter(
      (action) => action !== "submit" || state.gitRoot !== undefined,
    );
    return { ...state, actionFocus: cycleAction(enabled, state.actionFocus, dir) };
  }
  if (state.mode === "failed") {
    return { ...state, actionFocus: cycleAction(FAILED_ACTIONS, state.actionFocus, dir) };
  }
  return state;
}

function cycleAction<T extends string>(actions: readonly T[], current: T, dir: -1 | 1): T {
  const currentIndex = actions.indexOf(current);
  const start = currentIndex < 0 ? (dir === 1 ? -1 : 0) : currentIndex;
  const next = (start + dir + actions.length) % actions.length;
  return actions[next] ?? current;
}

function updateFilter(state: AddProjectFlowState, filter: string): AddProjectTransition {
  if (state.mode !== "choose") {
    return { state };
  }
  const searchQuery = searchQueryForFilter(filter);
  const nextState = withoutSearchError({
    ...state,
    filter,
    searchEntries: [],
    searching: searchQuery !== undefined,
    searchTruncated: false,
  });
  return {
    state: nextState,
    ...(searchQuery === undefined
      ? {}
      : { effects: [{ type: "searchDirectories" as const, query: searchQuery }] }),
  };
}
