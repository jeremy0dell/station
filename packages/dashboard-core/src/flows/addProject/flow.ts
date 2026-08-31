import {
  createEditableTextInputState,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { type AddProjectActionFocus, addProjectActions } from "./actions.js";
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
  AddProjectFlowAction,
  AddProjectFlowState,
  AddProjectTransition,
  CreateAddProjectFlowInput,
} from "./types.js";

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
      if (state.mode !== "start") {
        return { state };
      }
      return { state, effects: [{ type: "loadDirectory", path: action.path }] };
    case "chooseOpen":
      if (state.mode !== "choose") {
        return { state };
      }
      return { state, effects: [{ type: "loadDirectory", path: action.path }] };
    case "chooseParent":
      if (state.mode !== "choose") {
        return { state };
      }
      return {
        state,
        effects: [
          parentPath === undefined
            ? { type: "loadDirectory", path: state.currentPath, parent: true }
            : { type: "loadDirectory", path: parentPath(state.currentPath) },
        ],
      };
    case "chooseSelected":
      if (state.mode !== "choose") {
        return { state };
      }
      return { state, effects: [{ type: "reviewFolder", path: action.path }] };
    case "folderLoaded":
      return {
        state: chooseStateForLoadedFolder(state, action.result.path, action.result.entries),
      };
    case "folderLoadFailed":
      return {
        state: chooseStateForLoadedFolder(state, action.path, [], { error: action.error }),
      };
    case "folderSearchLoaded":
      if (state.mode !== "choose" || action.result.query !== normalizedFilter(state.filter)) {
        return { state };
      }
      return {
        state: withoutSearchError({
          ...state,
          searchEntries: action.result.entries,
          searching: false,
          searchTruncated: action.result.truncated,
        }),
      };
    case "folderSearchFailed":
      if (state.mode !== "choose" || action.query !== normalizedFilter(state.filter)) {
        return { state };
      }
      return {
        state: {
          ...state,
          searchEntries: [],
          searching: false,
          searchTruncated: false,
          searchError: action.error,
        },
      };
    case "folderReviewed":
      return { state: reviewStateForFolder(state, action.review) };
    case "folderReviewFailed":
      return { state: failedStateForError(state, action.path, action.error) };
    case "filterStart":
      if (state.mode !== "choose") {
        return { state };
      }
      return { state: { ...state, filterMode: true } };
    case "filterInput":
      return updateFilter(state, `${state.mode === "choose" ? state.filter : ""}${action.value}`);
    case "filterBackspace":
      return updateFilter(state, state.mode === "choose" ? state.filter.slice(0, -1) : "");
    case "filterClear":
      if (state.mode !== "choose") {
        return { state };
      }
      return {
        state: withoutSearchError({
          ...state,
          filter: "",
          filterMode: false,
          searchEntries: [],
          searching: false,
          searchTruncated: false,
        }),
      };
    case "submit":
      return submitReview(state);
    case "submitted":
      return { state: successStateForProject(state, action.label, action.root) };
    case "submitFailed":
      if (state.mode !== "review") {
        return { state };
      }
      return { state: failedStateForError(state, state.selectedPath, action.error) };
    case "editIdStart":
      if (state.mode !== "review" || state.submitting) {
        return { state };
      }
      return {
        state: {
          ...state,
          actionFocus: "editId",
          editingId: createEditableTextInputState(state.id),
          editIdActionFocus: "save",
        },
      };
    case "editIdInput":
      if (state.mode !== "review" || state.editingId === undefined) {
        return { state };
      }
      return {
        state: {
          ...state,
          editingId: transitionEditableTextInput(state.editingId, action.action),
        },
      };
    case "editIdCommit":
      if (state.mode !== "review" || state.editingId === undefined) {
        return { state };
      }
      return { state: commitEditedProjectId(state) };
    case "editIdCancel":
      if (state.mode !== "review" || state.editingId === undefined) {
        return { state };
      }
      return { state: reviewWithoutEditingId(state) };
    case "actionFocus":
      return { state: moveActionFocus(state, action.dir) };
    case "backToChoose":
      if (state.mode !== "review" && state.mode !== "failed") {
        return { state };
      }
      return { state, effects: [{ type: "loadDirectory", path: state.selectedPath }] };
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
        editIdActionFocus: nextEnabledActionFocus(state, state.editIdActionFocus ?? "save", dir),
      };
    }
    return {
      ...state,
      actionFocus: nextEnabledActionFocus(state, state.actionFocus, dir),
    };
  }
  if (state.mode === "failed") {
    return {
      ...state,
      actionFocus: nextEnabledActionFocus(state, state.actionFocus, dir),
    };
  }
  return state;
}

function nextEnabledActionFocus<TFocus extends AddProjectActionFocus>(
  state: AddProjectFlowState,
  current: TFocus,
  dir: -1 | 1,
): TFocus {
  const actions = addProjectActions(state).flatMap((action) =>
    action.enabled && action.focus !== undefined ? [action.focus as TFocus] : [],
  );
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
