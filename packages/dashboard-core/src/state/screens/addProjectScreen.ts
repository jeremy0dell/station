import { dirname } from "node:path";
import { editableTextInputIntentForInput } from "../../components/EditableTextInput/editing.js";
import {
  type AddProjectActionFocus,
  type AddProjectActionId,
  addProjectAction,
  addProjectActions,
} from "../../flows/addProject/actions.js";
import { createAddProjectFlow } from "../../flows/addProject/flow.js";
import { pastedPathCandidate } from "../../flows/addProject/input.js";
import { addProjectRows } from "../../flows/addProject/rows.js";
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
  addProjectSelectedIndexForFlow,
  reconcileAddProjectSelection,
  selectAddProjectRowById,
  selectedAddProjectFolderRow,
} from "../selection/addProject.js";
import { commitCurrentCursor } from "../selection/engine.js";
import {
  addProjectChooseListSpec,
  addProjectStartListSpec,
} from "../selection/specs/addProject.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";
import { applyAddProjectAction } from "./addProjectTransition.js";

export type AddProjectInputIntent =
  | { type: "none" }
  | { type: "close" }
  | { type: "commitCurrentCursor" }
  | { type: "retry"; path: string }
  | { type: "transition"; action: AddProjectFlowAction };

export const addProjectScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelAddProject,
};

export function openAddProject(
  state: DashboardState,
  input: CreateAddProjectFlowInput,
): DashboardState {
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

export function handleAddProjectKey(state: DashboardState, key: TuiKey): TuiTransition {
  return executeAddProjectIntent(state, addProjectIntentForInput(state, key));
}

/** Applies an enabled Add Project action through the same intent executor used by keyboard input. */
export function handleAddProjectAction(
  state: DashboardState,
  actionId: AddProjectActionId,
): TuiTransition {
  return executeAddProjectIntent(state, addProjectIntentForAction(state, actionId));
}

function executeAddProjectIntent(
  state: DashboardState,
  intent: AddProjectInputIntent,
): TuiTransition {
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

function cancelAddProject(state: DashboardState): DashboardState {
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

function closeAddProject(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}

/**
 * Resolves only visible, enabled Add Project actions; a pasted path takes precedence over the
 * chooser cursor so pointer and keyboard activation share one target.
 */
export function addProjectIntentForAction(
  state: DashboardState,
  actionId: AddProjectActionId,
): AddProjectInputIntent {
  if (state.screen.name !== "addProject") return { type: "none" };
  const flow = state.screen.flow;
  const selectedIndex = addProjectSelectedIndexForFlow(flow, state.selection);
  const descriptor = addProjectAction(flow, actionId, selectedIndex);
  if (descriptor?.enabled !== true) return { type: "none" };

  switch (actionId) {
    case "start.open":
      return { type: "commitCurrentCursor" };
    case "choose.choose": {
      const path = flow.mode === "choose" ? pastedPathCandidate(flow.filter) : undefined;
      return path === undefined
        ? { type: "commitCurrentCursor" }
        : transitionIntent({ type: "chooseSelected", path });
    }
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

function addProjectIntentForInput(state: DashboardState, key: TuiKey): AddProjectInputIntent {
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
  state: DashboardState,
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
  state: DashboardState,
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
  if (isReturnKey(key)) return addProjectIntentForAction(state, "choose.choose");
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
  state: DashboardState,
  flow: AddProjectReviewState,
  key: TuiKey,
): AddProjectInputIntent {
  if (key.leftArrow === true) return transitionIntent({ type: "actionFocus", dir: -1 });
  if (key.rightArrow === true) return transitionIntent({ type: "actionFocus", dir: 1 });
  if (key.input === "A") return addProjectIntentForAction(state, "review.submit");
  if (key.input === "N") return addProjectIntentForAction(state, "review.editId");
  if (key.input === "B") return addProjectIntentForAction(state, "review.chooseFolder");
  if (!isReturnKey(key)) return { type: "none" };
  return focusedActionIntent(state, flow, flow.actionFocus);
}

function failedIntent(
  state: DashboardState,
  flow: Extract<AddProjectFlowState, { mode: "failed" }>,
  key: TuiKey,
): AddProjectInputIntent {
  if (key.leftArrow === true) return transitionIntent({ type: "actionFocus", dir: -1 });
  if (key.rightArrow === true) return transitionIntent({ type: "actionFocus", dir: 1 });
  if (key.input === "R") return addProjectIntentForAction(state, "failed.retry");
  if (key.input === "B") return addProjectIntentForAction(state, "failed.chooseFolder");
  if (!isReturnKey(key)) return { type: "none" };
  return focusedActionIntent(state, flow, flow.actionFocus);
}

function focusedActionIntent(
  state: DashboardState,
  flow: AddProjectFlowState,
  focus: AddProjectActionFocus,
): AddProjectInputIntent {
  const actionId = addProjectActions(flow).find((action) => action.focus === focus)?.id;
  return actionId === undefined ? { type: "none" } : addProjectIntentForAction(state, actionId);
}

function transitionIntent(action: AddProjectFlowAction): AddProjectInputIntent {
  return { type: "transition", action };
}

/** Pointer selection writes the canonical semantic cursor shared by arrows and Enter. */
export function selectAddProjectRow(state: DashboardState, itemId: string): DashboardState {
  return selectAddProjectRowById(state, itemId);
}

export function applyAddProjectFolderLoaded(
  state: DashboardState,
  result: TuiFolderReadResult,
): DashboardState {
  return applyAddProjectAction(state, { type: "folderLoaded", result }).state;
}

export function applyAddProjectFolderRefreshed(
  state: DashboardState,
  result: TuiFolderReadResult,
): DashboardState {
  if (
    state.screen.name !== "addProject" ||
    state.screen.flow.mode !== "choose" ||
    state.screen.flow.currentPath !== result.path
  ) {
    return state;
  }
  const flow = state.screen.flow;
  if (sameFolderEntries(flow.entries, result.entries)) {
    return state;
  }
  const selectedIndex = addProjectSelectedIndexForFlow(flow, state.selection);
  const selectedPath = selectedAddProjectFolderRow(state)?.path;
  const refreshed = reconcileAddProjectSelection(
    {
      ...state,
      screen: { name: "addProject", flow: { ...flow, entries: result.entries } },
    },
    flow,
    false,
  );
  if (
    selectedIndex === undefined ||
    selectedPath === undefined ||
    selectedAddProjectFolderRow(refreshed)?.path === selectedPath
  ) {
    return refreshed;
  }
  if (refreshed.screen.name !== "addProject" || refreshed.screen.flow.mode !== "choose") {
    return refreshed;
  }
  const refreshedRows = addProjectRows(refreshed.screen.flow);
  const replacement = refreshedRows[Math.min(selectedIndex, refreshedRows.length - 1)];
  return replacement === undefined
    ? refreshed
    : selectAddProjectRowById(refreshed, replacement.path);
}

export function applyAddProjectFolderLoadFailed(
  state: DashboardState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): DashboardState {
  return applyAddProjectAction(state, {
    type: "folderLoadFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectFolderSearchLoaded(
  state: DashboardState,
  result: TuiFolderSearchResult,
): DashboardState {
  return applyAddProjectAction(state, { type: "folderSearchLoaded", result }).state;
}

export function applyAddProjectFolderSearchFailed(
  state: DashboardState,
  query: string,
  error: unknown,
  clientLabel = "TUI",
): DashboardState {
  return applyAddProjectAction(state, {
    type: "folderSearchFailed",
    query,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectFolderReviewed(
  state: DashboardState,
  review: TuiFolderReview,
): DashboardState {
  return applyAddProjectAction(state, { type: "folderReviewed", review }).state;
}

export function applyAddProjectFolderReviewFailed(
  state: DashboardState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): DashboardState {
  return applyAddProjectAction(state, {
    type: "folderReviewFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  }).state;
}

export function applyAddProjectSubmitted(
  state: DashboardState,
  input: { label: string; root: string },
): DashboardState {
  return applyAddProjectAction(state, { type: "submitted", ...input }).state;
}

export function applyAddProjectSubmitFailed(
  state: DashboardState,
  error: unknown,
  clientLabel = "TUI",
): DashboardState {
  return applyAddProjectAction(state, {
    type: "submitFailed",
    error: toSafeError(error, { clientLabel }),
  }).state;
}

function sameFolderEntries(
  left: TuiFolderReadResult["entries"],
  right: TuiFolderReadResult["entries"],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.name === other.name &&
        entry.path === other.path &&
        entry.kind === other.kind &&
        entry.displayPath === other.displayPath
      );
    })
  );
}
