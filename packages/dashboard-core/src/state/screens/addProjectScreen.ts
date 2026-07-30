import { dirname } from "node:path";
import { editableTextInputIntentForInput } from "../../components/EditableTextInput/editing.js";
import { type AddProjectActionId, addProjectAction } from "../../flows/addProject/actions.js";
import { createAddProjectFlow } from "../../flows/addProject/flow.js";
import { pastedPathCandidate } from "../../flows/addProject/input.js";
import type {
  AddProjectChooseState,
  AddProjectFlowAction,
  AddProjectFlowState,
  AddProjectReviewState,
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
} from "../selection/addProject.js";
import { commitCurrentCursor } from "../selection/engine.js";
import {
  addProjectChooseListSpec,
  addProjectStartListSpec,
} from "../selection/specs/addProject.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { applyAddProjectAction } from "./addProjectTransition.js";

export type AddProjectInputIntent =
  | { type: "none" }
  | { type: "close" }
  | { type: "commitCurrentCursor" }
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
  return executeAddProjectIntent(state, addProjectIntentForInput(state, key));
}

/** Applies an enabled Add Project action through the same intent executor used by keyboard input. */
export function handleAddProjectAction(
  state: TuiState,
  actionId: AddProjectActionId,
): TuiTransition {
  return executeAddProjectIntent(state, addProjectIntentForAction(state, actionId));
}

function executeAddProjectIntent(state: TuiState, intent: AddProjectInputIntent): TuiTransition {
  switch (intent.type) {
    case "none":
      return { state };
    case "close":
      return { state: closeAddProject(state) };
    case "commitCurrentCursor": {
      if (state.screen.name !== "addProject") return { state };
      const spec =
        state.screen.flow.mode === "start"
          ? addProjectStartListSpec
          : state.screen.flow.mode === "choose"
            ? addProjectChooseListSpec
            : undefined;
      return spec === undefined ? { state } : commitCurrentCursor(spec, state);
    }
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
  if (flow.mode === "review" && flow.submitting) {
    return state;
  }
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

/** Resolves only actions that are visible and enabled in the current Add Project state. */
export function addProjectIntentForAction(
  state: TuiState,
  actionId: AddProjectActionId,
): AddProjectInputIntent {
  if (state.screen.name !== "addProject") return { type: "none" };
  const flow = state.screen.flow;
  const descriptor = addProjectAction(flow, actionId);
  if (descriptor?.enabled !== true) return { type: "none" };

  switch (actionId) {
    case "start.open":
    case "choose.choose":
      return { type: "commitCurrentCursor" };
    case "start.cancel":
    case "review.cancel":
    case "success.dashboard":
    case "failed.cancel":
      return { type: "close" };
    case "choose.open": {
      const row = selectedAddProjectFolderRow(state);
      return row === undefined || row.kind === "current"
        ? { type: "none" }
        : transitionIntent({ type: "chooseOpen", path: row.path });
    }
    case "choose.parent":
      return transitionIntent({ type: "chooseParent" });
    case "choose.search":
      return transitionIntent({ type: "filterStart" });
    case "choose.cancel":
      return flow.mode === "choose" && (flow.filterMode || flow.filter.length > 0)
        ? transitionIntent({ type: "filterClear" })
        : { type: "close" };
    case "review.submit":
      return transitionIntent({ type: "submit" });
    case "review.editId":
      return transitionIntent({ type: "editIdStart" });
    case "review.chooseFolder":
    case "failed.chooseFolder":
      return transitionIntent({ type: "backToChoose" });
    case "editId.save":
      return transitionIntent({ type: "editIdCommit" });
    case "editId.back":
      return transitionIntent({ type: "editIdCancel" });
    case "failed.retry":
      return flow.mode === "failed" ? { type: "retry", path: flow.selectedPath } : { type: "none" };
  }
}

function addProjectIntentForInput(state: TuiState, key: TuiKey): AddProjectInputIntent {
  if (state.screen.name !== "addProject") return { type: "none" };
  const flow = state.screen.flow;
  if (flow.mode === "review" && flow.submitting) return { type: "none" };
  if (flow.mode === "review" && flow.editingId !== undefined) {
    return editProjectIdIntent(state, flow, key);
  }
  if (key.escape === true) {
    if (flow.mode === "start") return addProjectIntentForAction(state, "start.cancel");
    if (flow.mode === "choose") return addProjectIntentForAction(state, "choose.cancel");
    if (flow.mode === "review") return addProjectIntentForAction(state, "review.cancel");
    if (flow.mode === "failed") return addProjectIntentForAction(state, "failed.cancel");
    return { type: "close" };
  }
  switch (flow.mode) {
    case "start":
      return key.rightArrow === true
        ? addProjectIntentForAction(state, "start.open")
        : { type: "none" };
    case "choose":
      return chooseIntent(state, flow, key);
    case "review":
      return reviewIntent(state, flow, key);
    case "success":
      return isReturnKey(key) || key.input === "D"
        ? addProjectIntentForAction(state, "success.dashboard")
        : { type: "none" };
    case "failed":
      return failedIntent(state, flow, key);
  }
}

function editProjectIdIntent(
  state: TuiState,
  flow: AddProjectReviewState,
  key: TuiKey,
): AddProjectInputIntent {
  if (key.upArrow === true) return transitionIntent({ type: "actionFocus", dir: -1 });
  if (key.downArrow === true) return transitionIntent({ type: "actionFocus", dir: 1 });
  if (key.escape === true) return addProjectIntentForAction(state, "editId.back");
  if (key.ctrl === true && key.input === "s") {
    return addProjectIntentForAction(state, "editId.save");
  }
  if (isReturnKey(key)) {
    return addProjectIntentForAction(
      state,
      flow.editIdActionFocus === "back" ? "editId.back" : "editId.save",
    );
  }
  const intent = editableTextInputIntentForInput({ input: key.input, key });
  return intent.type === "edit"
    ? transitionIntent({ type: "editIdInput", action: intent.action })
    : { type: "none" };
}

function chooseIntent(
  state: TuiState,
  flow: AddProjectChooseState,
  key: TuiKey,
): AddProjectInputIntent {
  if (flow.filterMode) {
    const intent = filterInputIntent(key);
    if (intent.type !== "none") return intent;
  }
  if (key.rightArrow === true) return addProjectIntentForAction(state, "choose.open");
  if (key.leftArrow === true) return addProjectIntentForAction(state, "choose.parent");
  if (key.input === "/") return addProjectIntentForAction(state, "choose.search");
  if (isReturnKey(key)) {
    const path = pastedPathCandidate(flow.filter);
    return path === undefined
      ? addProjectIntentForAction(state, "choose.choose")
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

function reviewIntent(
  state: TuiState,
  flow: AddProjectReviewState,
  key: TuiKey,
): AddProjectInputIntent {
  if (key.upArrow === true) return transitionIntent({ type: "actionFocus", dir: -1 });
  if (key.downArrow === true) return transitionIntent({ type: "actionFocus", dir: 1 });
  if (key.input === "A") return addProjectIntentForAction(state, "review.submit");
  if (key.input === "N") return addProjectIntentForAction(state, "review.editId");
  if (key.input === "B") return addProjectIntentForAction(state, "review.chooseFolder");
  if (!isReturnKey(key)) return { type: "none" };
  const actionId: AddProjectActionId =
    flow.actionFocus === "submit"
      ? "review.submit"
      : flow.actionFocus === "editId"
        ? "review.editId"
        : flow.actionFocus === "chooseFolder"
          ? "review.chooseFolder"
          : "review.cancel";
  return addProjectIntentForAction(state, actionId);
}

function failedIntent(
  state: TuiState,
  flow: Extract<AddProjectFlowState, { mode: "failed" }>,
  key: TuiKey,
): AddProjectInputIntent {
  if (key.upArrow === true) return transitionIntent({ type: "actionFocus", dir: -1 });
  if (key.downArrow === true) return transitionIntent({ type: "actionFocus", dir: 1 });
  if (key.input === "R") return addProjectIntentForAction(state, "failed.retry");
  if (key.input === "B") return addProjectIntentForAction(state, "failed.chooseFolder");
  if (!isReturnKey(key)) return { type: "none" };
  const actionId: AddProjectActionId =
    flow.actionFocus === "retry"
      ? "failed.retry"
      : flow.actionFocus === "chooseFolder"
        ? "failed.chooseFolder"
        : "failed.cancel";
  return addProjectIntentForAction(state, actionId);
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
