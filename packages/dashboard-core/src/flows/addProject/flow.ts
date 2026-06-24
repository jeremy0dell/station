import {
  createEditableTextInputState,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { normalizedFilter, pastedPathCandidate, searchQueryForFilter } from "./input.js";
import { addProjectRows } from "./rows.js";
import {
  chooseStateForLoadedFolder,
  clampChooseSelection,
  clampIndex,
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
    case "move":
      return { state: moveSelection(state, action.delta) };
    case "startOpen": {
      if (state.mode !== "start") return { state };
      const choice = state.choices[state.selectedIndex];
      return choice === undefined
        ? { state }
        : { state, effects: [{ type: "loadDirectory", path: choice.path }] };
    }
    case "chooseOpen":
      return chooseOpen(state);
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
      return chooseSelected(state);
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
            state: clampChooseSelection(
              withoutSearchError({
                ...state,
                searchEntries: action.result.entries,
                searching: false,
                searchTruncated: action.result.truncated,
              }),
            ),
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
              selectedIndex: 0,
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
      return state.mode === "review"
        ? { state: { ...state, editingId: createEditableTextInputState(state.id) } }
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
    case "backToChoose":
      return state.mode === "review" || state.mode === "failed"
        ? { state, effects: [{ type: "loadDirectory", path: state.selectedPath }] }
        : { state };
  }
}

function chooseOpen(state: AddProjectFlowState): AddProjectTransition {
  if (state.mode !== "choose") return { state };
  const row = addProjectRows(state)[state.selectedIndex];
  if (row === undefined || row.kind === "current") return { state };
  return { state, effects: [{ type: "loadDirectory", path: row.path }] };
}

function chooseSelected(state: AddProjectFlowState): AddProjectTransition {
  if (state.mode === "start") {
    const choice = state.choices[state.selectedIndex];
    return choice === undefined
      ? { state }
      : { state, effects: [{ type: "loadDirectory", path: choice.path }] };
  }
  if (state.mode !== "choose") return { state };
  const row = addProjectRows(state)[state.selectedIndex];
  if (row !== undefined) {
    return { state, effects: [{ type: "reviewFolder", path: row.path }] };
  }
  const pastedPath = pastedPathCandidate(state.filter);
  return pastedPath === undefined
    ? { state }
    : { state, effects: [{ type: "reviewFolder", path: pastedPath }] };
}

function submitReview(state: AddProjectFlowState): AddProjectTransition {
  if (state.mode !== "review" || state.editingId !== undefined) return { state };
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
            ...(state.gitRoot === undefined ? { allowNonGit: true } : {}),
          },
        },
      },
    ],
  };
}

function moveSelection(state: AddProjectFlowState, delta: number): AddProjectFlowState {
  if (state.mode === "start") {
    return {
      ...state,
      selectedIndex: clampIndex(state.selectedIndex + delta, 0, state.choices.length - 1),
    };
  }
  if (state.mode === "choose") {
    const count = addProjectRows(state).length;
    return { ...state, selectedIndex: clampIndex(state.selectedIndex + delta, 0, count - 1) };
  }
  return state;
}

function updateFilter(state: AddProjectFlowState, filter: string): AddProjectTransition {
  if (state.mode !== "choose") {
    return { state };
  }
  const searchQuery = searchQueryForFilter(filter);
  const nextState = clampChooseSelection(
    withoutSearchError({
      ...state,
      filter,
      searchEntries: [],
      searching: searchQuery !== undefined,
      searchTruncated: false,
    }),
  );
  return {
    state: nextState,
    ...(searchQuery === undefined
      ? {}
      : { effects: [{ type: "searchDirectories" as const, query: searchQuery }] }),
  };
}
