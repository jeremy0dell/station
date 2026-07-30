import type { AddProjectActionId } from "../flows/addProject/actions.js";
import type { NewSessionActionId } from "../flows/newSession.js";
import { handleAddProjectAction } from "./screens/addProjectScreen.js";
import { handleFirstProjectAddAction } from "./screens/dashboard.js";
import { handleNewSessionAction } from "./screens/newSession.js";
import type { TuiRuntimeContext, TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

/** Renderer-neutral actions shared by mouse, accelerators, and focused activation. */
export type TuiSemanticAction =
  | { type: "dashboard.addProject" }
  | { type: "addProject.activate"; actionId: AddProjectActionId }
  | { type: "newSession.activate"; actionId: NewSessionActionId };

/** Resolves a semantic TUI action into the same pure transition used by keyboard input. */
export function handleTuiAction(
  state: TuiState,
  action: TuiSemanticAction,
  context: TuiRuntimeContext,
): TuiTransition {
  switch (action.type) {
    case "dashboard.addProject":
      return handleFirstProjectAddAction(state, context);
    case "addProject.activate":
      return handleAddProjectAction(state, action.actionId);
    case "newSession.activate":
      return handleNewSessionAction(state, action.actionId);
  }
}
