import { transitionAddProjectFlow } from "../../flows/addProject/flow.js";
import type { AddProjectFlowAction, AddProjectFlowEffect } from "../../flows/addProject/types.js";
import { reconcileAddProjectSelection } from "../selection/addProject.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export function applyAddProjectAction(
  state: TuiState,
  action: AddProjectFlowAction,
  parentPath?: (path: string) => string,
): TuiTransition {
  if (state.screen.name !== "addProject") {
    return { state };
  }
  const previousFlow = state.screen.flow;
  const transition = transitionAddProjectFlow(previousFlow, action, parentPath);
  const nextState =
    transition.state === undefined
      ? state
      : reconcileAddProjectSelection(
          { ...state, screen: { name: "addProject", flow: transition.state } },
          previousFlow,
          resetsSelection(action),
        );
  const result: TuiTransition = { state: nextState };
  const operations = addProjectEffectsToOperations(transition.effects);
  if (operations !== undefined) {
    result.operations = operations;
  }
  return result;
}

function resetsSelection(action: AddProjectFlowAction): boolean {
  return (
    action.type === "folderLoaded" ||
    action.type === "folderLoadFailed" ||
    action.type === "filterClear"
  );
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
