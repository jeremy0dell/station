import { dirname } from "node:path";
import { editableTextInputIntentForInput } from "../../components/EditableTextInput/editing.js";
import { createAddProjectFlow } from "../../flows/addProject/flow.js";
import { pastedPathCandidate } from "../../flows/addProject/input.js";
import type {
  AddProjectChooseState,
  AddProjectFailedState,
  AddProjectFlowAction,
  AddProjectFlowState,
  CreateAddProjectFlowInput,
} from "../../flows/addProject/types.js";
import { toSafeError } from "../../services/errors/errors.js";
import type {
  TuiFolderReadResult,
  TuiFolderReview,
  TuiFolderSearchResult,
} from "../../services/folderService.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import {
  reconcileAddProjectSelection,
  selectAddProjectRowByIndex,
  selectedAddProjectFolderRow,
  selectedAddProjectStartPath,
} from "../selection/addProject.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { applyAddProjectAction } from "./addProjectTransition.js";

type AddProjectInputIntent =
  | { type: "none" }
  | { type: "close" }
  | { type: "retry"; path: string }
  | { type: "transition"; action: AddProjectFlowAction };

export const addProjectScreenBehavior = { clickAway: cancelAddProject };

export function openAddProject(state: TuiState, input: CreateAddProjectFlowInput): TuiState {
  return reconcileAddProjectSelection(
    {
      ...state,
      screen: {
        name: "addProject",
        flow: createAddProjectFlow(input),
      },
    },
    undefined,
    true,
  );
}

export function handleAddProjectKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "addProject") {
    return { state };
  }

  const intent = addProjectIntentForInput(state, key);
  switch (intent.type) {
    case "none":
      return { state };
    case "close":
      return { state: closeAddProject(state) };
    case "retry":
      return {
        state,
        operations: [{ type: "reviewProjectFolder", path: intent.path }],
      };
    case "transition":
      return applyAddProjectAction(state, intent.action, dirname);
  }
}

function cancelAddProject(state: TuiState): TuiState {
  if (state.screen.name !== "addProject") {
    return state;
  }
  const flow = state.screen.flow;
  if (flow.mode === "review" && flow.editingId !== undefined) {
    return applyAddProjectAction(state, { type: "editIdCancel" }).state;
  }
  if (flow.mode === "choose" && (flow.filterMode || flow.filter.length > 0)) {
    return applyAddProjectAction(state, { type: "filterClear" }).state;
  }
  return closeAddProject(state);
}

function closeAddProject(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}

function addProjectIntentForInput(state: TuiState, key: TuiKey): AddProjectInputIntent {
  if (state.screen.name !== "addProject") {
    return { type: "none" };
  }
  const flow = state.screen.flow;
  if (flow.mode === "review" && flow.editingId !== undefined) {
    return editProjectIdIntent(key);
  }
  if (key.escape === true) {
    return escapeIntent(flow);
  }
  switch (flow.mode) {
    case "start":
      return startIntent(state, key);
    case "choose":
      return chooseIntent(state, flow, key);
    case "review":
      return reviewIntent(key);
    case "success":
      return isReturnKey(key) ? { type: "close" } : { type: "none" };
    case "failed":
      return failedIntent(flow, key);
  }
}

function editProjectIdIntent(key: TuiKey): AddProjectInputIntent {
  if (key.escape === true) {
    return transitionIntent({ type: "editIdCancel" });
  }
  if (isReturnKey(key)) {
    return transitionIntent({ type: "editIdCommit" });
  }
  const intent = editableTextInputIntentForInput({ input: key.input, key });
  return intent.type === "edit"
    ? transitionIntent({ type: "editIdInput", action: intent.action })
    : { type: "none" };
}

function escapeIntent(flow: AddProjectFlowState): AddProjectInputIntent {
  return flow.mode === "choose" && (flow.filterMode || flow.filter.length > 0)
    ? transitionIntent({ type: "filterClear" })
    : { type: "close" };
}

function startIntent(state: TuiState, key: TuiKey): AddProjectInputIntent {
  if (key.rightArrow !== true) {
    return { type: "none" };
  }
  const path = selectedAddProjectStartPath(state);
  return path === undefined ? { type: "none" } : transitionIntent({ type: "startOpen", path });
}

function chooseIntent(
  state: TuiState,
  flow: AddProjectChooseState,
  key: TuiKey,
): AddProjectInputIntent {
  if (flow.filterMode) {
    const intent = filterInputIntent(key);
    if (intent.type !== "none") {
      return intent;
    }
  }
  if (key.rightArrow === true) {
    const row = selectedAddProjectFolderRow(state);
    return row === undefined || row.kind === "current"
      ? { type: "none" }
      : transitionIntent({ type: "chooseOpen", path: row.path });
  }
  if (key.leftArrow === true) {
    return transitionIntent({ type: "chooseParent" });
  }
  if (key.input === "/") {
    return transitionIntent({ type: "filterStart" });
  }
  if (isReturnKey(key)) {
    const path = pastedPathCandidate(flow.filter);
    return path === undefined
      ? { type: "none" }
      : transitionIntent({ type: "chooseSelected", path });
  }
  return { type: "none" };
}

function filterInputIntent(key: TuiKey): AddProjectInputIntent {
  if (key.backspace === true || key.delete === true) {
    return transitionIntent({ type: "filterBackspace" });
  }
  if (key.ctrl === true && key.input === "u") {
    return transitionIntent({ type: "filterClear" });
  }
  if (key.input.length > 0 && !isReturnKey(key)) {
    return transitionIntent({ type: "filterInput", value: key.input });
  }
  return { type: "none" };
}

function reviewIntent(key: TuiKey): AddProjectInputIntent {
  if (key.input === "N") {
    return transitionIntent({ type: "editIdStart" });
  }
  if (key.input === "B") {
    return transitionIntent({ type: "backToChoose" });
  }
  return isReturnKey(key) ? transitionIntent({ type: "submit" }) : { type: "none" };
}

function failedIntent(flow: AddProjectFailedState, key: TuiKey): AddProjectInputIntent {
  if (key.input === "R") {
    return { type: "retry", path: flow.selectedPath };
  }
  return key.input === "B" ? transitionIntent({ type: "backToChoose" }) : { type: "none" };
}

function transitionIntent(action: AddProjectFlowAction): AddProjectInputIntent {
  return { type: "transition", action };
}

/** Mouse selection writes the canonical cursor shared by arrows and Enter. */
export function selectAddProjectRow(state: TuiState, index: number): TuiState {
  return selectAddProjectRowByIndex(state, index);
}

export function applyAddProjectFolderLoaded(
  state: TuiState,
  result: TuiFolderReadResult,
): TuiState {
  return applyAddProjectAction(state, { type: "folderLoaded", result }).state;
}

export function applyAddProjectFolderLoadFailed(
  state: TuiState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyAddProjectAction(state, {
    type: "folderLoadFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectFolderSearchLoaded(
  state: TuiState,
  result: TuiFolderSearchResult,
): TuiState {
  return applyAddProjectAction(state, { type: "folderSearchLoaded", result }).state;
}

export function applyAddProjectFolderSearchFailed(
  state: TuiState,
  query: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyAddProjectAction(state, {
    type: "folderSearchFailed",
    query,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectFolderReviewed(state: TuiState, review: TuiFolderReview): TuiState {
  return applyAddProjectAction(state, { type: "folderReviewed", review }).state;
}

export function applyAddProjectFolderReviewFailed(
  state: TuiState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyAddProjectAction(state, {
    type: "folderReviewFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectSubmitted(
  state: TuiState,
  input: { label: string; root: string },
): TuiState {
  return applyAddProjectAction(state, { type: "submitted", ...input }).state;
}

export function applyAddProjectSubmitFailed(
  state: TuiState,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyAddProjectAction(state, {
    type: "submitFailed",
    error: toSafeError(error, { clientLabel }),
  }).state;
}
