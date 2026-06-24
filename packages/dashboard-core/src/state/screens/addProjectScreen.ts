import { dirname } from "node:path";
import { editableTextInputIntentForInput } from "../../components/EditableTextInput/editing.js";
import { createAddProjectFlow, transitionAddProjectFlow } from "../../flows/addProject/flow.js";
import type { AddProjectFlowEffect } from "../../flows/addProject/types.js";
import { toSafeError } from "../../services/errors/errors.js";
import type {
  TuiFolderReadResult,
  TuiFolderReview,
  TuiFolderSearchResult,
} from "../../services/folderService.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export function openAddProject(state: TuiState, input: { cwd: string; homeDir: string }): TuiState {
  return {
    ...state,
    screen: {
      name: "addProject",
      flow: createAddProjectFlow(input),
    },
  };
}

export function handleAddProjectKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "addProject") {
    return { state };
  }

  const flow = state.screen.flow;
  if (flow.mode === "review" && flow.editingId !== undefined) {
    if (key.escape === true) {
      return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "editIdCancel" }));
    }
    if (isReturnKey(key)) {
      return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "editIdCommit" }));
    }
    const intent = editableTextInputIntentForInput({ input: key.input, key });
    return intent.type === "edit"
      ? applyFlowTransition(
          state,
          transitionAddProjectFlow(flow, { type: "editIdInput", action: intent.action }),
        )
      : { state };
  }

  if (key.escape === true) {
    if (flow.mode === "choose" && (flow.filterMode || flow.filter.length > 0)) {
      return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "filterClear" }));
    }
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  if (flow.mode === "choose" && flow.filterMode) {
    if (key.backspace === true || key.delete === true) {
      return applyFlowTransition(
        state,
        transitionAddProjectFlow(flow, { type: "filterBackspace" }),
      );
    }
    if (key.ctrl === true && key.input === "u") {
      return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "filterClear" }));
    }
    if (key.input.length > 0 && !isReturnKey(key)) {
      return applyFlowTransition(
        state,
        transitionAddProjectFlow(flow, { type: "filterInput", value: key.input }),
      );
    }
  }

  if (key.upArrow === true) {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "move", delta: -1 }));
  }
  if (key.downArrow === true) {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "move", delta: 1 }));
  }
  if (key.rightArrow === true) {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, rightArrowAction(flow.mode)));
  }
  if (key.leftArrow === true) {
    return applyFlowTransition(
      state,
      transitionAddProjectFlow(flow, { type: "chooseParent" }, dirname),
    );
  }
  if (key.input === "/") {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "filterStart" }));
  }
  if (key.input === "B") {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "backToChoose" }));
  }
  if (key.input === "N" && flow.mode === "review") {
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "editIdStart" }));
  }
  if (key.input === "R" && flow.mode === "failed") {
    return {
      state,
      operations: [{ type: "reviewProjectFolder", path: flow.selectedPath }],
    };
  }
  if (isReturnKey(key)) {
    if (flow.mode === "review") {
      return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "submit" }));
    }
    if (flow.mode === "success") {
      return { state: { ...state, screen: { name: "dashboard" } } };
    }
    return applyFlowTransition(state, transitionAddProjectFlow(flow, { type: "chooseSelected" }));
  }

  return { state };
}

export function applyAddProjectFolderLoaded(
  state: TuiState,
  result: TuiFolderReadResult,
): TuiState {
  return applyFlowTransitionState(state, { type: "folderLoaded", result });
}

export function applyAddProjectFolderLoadFailed(
  state: TuiState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyFlowTransitionState(state, {
    type: "folderLoadFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  });
}

export function applyAddProjectFolderSearchLoaded(
  state: TuiState,
  result: TuiFolderSearchResult,
): TuiState {
  return applyFlowTransitionState(state, { type: "folderSearchLoaded", result });
}

export function applyAddProjectFolderSearchFailed(
  state: TuiState,
  query: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyFlowTransitionState(state, {
    type: "folderSearchFailed",
    query,
    error: toSafeError(error, { clientLabel }),
  });
}

export function applyAddProjectFolderReviewed(state: TuiState, review: TuiFolderReview): TuiState {
  return applyFlowTransitionState(state, { type: "folderReviewed", review });
}

export function applyAddProjectFolderReviewFailed(
  state: TuiState,
  path: string,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyFlowTransitionState(state, {
    type: "folderReviewFailed",
    path,
    error: toSafeError(error, { clientLabel }),
  });
}

export function applyAddProjectSubmitted(
  state: TuiState,
  input: { label: string; root: string },
): TuiState {
  return applyFlowTransitionState(state, { type: "submitted", ...input });
}

export function applyAddProjectSubmitFailed(
  state: TuiState,
  error: unknown,
  clientLabel = "TUI",
): TuiState {
  return applyFlowTransitionState(state, {
    type: "submitFailed",
    error: toSafeError(error, { clientLabel }),
  });
}

function rightArrowAction(mode: string) {
  return mode === "start" ? ({ type: "startOpen" } as const) : ({ type: "chooseOpen" } as const);
}

function applyFlowTransition(
  state: TuiState,
  transition: ReturnType<typeof transitionAddProjectFlow>,
): TuiTransition {
  const nextState = transition.state === undefined ? state : setFlow(state, transition.state);
  const result: TuiTransition = { state: nextState };
  const operations = addProjectEffectsToOperations(transition.effects);
  if (operations !== undefined) {
    result.operations = operations;
  }
  return result;
}

function applyFlowTransitionState(
  state: TuiState,
  action: Parameters<typeof transitionAddProjectFlow>[1],
): TuiState {
  if (state.screen.name !== "addProject") {
    return state;
  }
  const transition = transitionAddProjectFlow(state.screen.flow, action);
  return transition.state === undefined ? state : setFlow(state, transition.state);
}

function setFlow(
  state: TuiState,
  flow: NonNullable<Extract<TuiState["screen"], { name: "addProject" }>["flow"]>,
): TuiState {
  return {
    ...state,
    screen: { name: "addProject", flow },
  };
}

function addProjectEffectsToOperations(effects: readonly AddProjectFlowEffect[] | undefined) {
  return effects?.map((effect) => {
    if (effect.type === "loadDirectory") {
      return { type: "loadProjectDirectory" as const, path: effect.path };
    }
    if (effect.type === "reviewFolder") {
      return { type: "reviewProjectFolder" as const, path: effect.path };
    }
    if (effect.type === "searchDirectories") {
      return { type: "searchProjectDirectories" as const, query: effect.query };
    }
    return { type: "addProject" as const, command: effect.command };
  });
}
