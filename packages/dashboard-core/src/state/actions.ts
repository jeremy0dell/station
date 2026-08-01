import type { ProjectId } from "@station/contracts";
import type { AddProjectActionId } from "../flows/addProject/actions.js";
import type { NewSessionActionId } from "../flows/newSession.js";
import {
  activateEmptyProjectAction,
  activateProjectHeaderControl,
} from "./projectHeaderActions.js";
import { handleAddProjectAction } from "./screens/addProjectScreen.js";
import { handleFirstProjectAddAction } from "./screens/dashboard.js";
import { type ForkSessionActionId, handleForkSessionAction } from "./screens/fork.js";
import { handleNewSessionAction } from "./screens/newSession.js";
import {
  handleRemoveWorktreeAction,
  type RemoveWorktreeActionId,
} from "./screens/removeWorktree.js";
import { submitRenameSession } from "./screens/renameSession.js";
import type { TuiRuntimeContext, TuiTransition } from "./transition.js";
import type { ProjectHeaderControl, TuiState } from "./types.js";

/** Renderer-neutral actions shared by mouse, accelerators, and focused activation. */
export type TuiSemanticAction =
  | { type: "dashboard.addProject" }
  | {
      type: "dashboard.projectHeader.activate";
      projectId: ProjectId;
      actionId: ProjectHeaderControl;
    }
  | { type: "dashboard.emptyProject.activate"; projectId: ProjectId }
  | { type: "addProject.activate"; actionId: AddProjectActionId }
  | { type: "newSession.activate"; actionId: NewSessionActionId }
  | { type: "removeWorktree.activate"; actionId: RemoveWorktreeActionId }
  | { type: "forkSession.activate"; actionId: ForkSessionActionId }
  | { type: "renameSession.submit" };

/** Resolves a semantic TUI action into the same pure transition used by keyboard input. */
export function handleTuiAction(
  state: TuiState,
  action: TuiSemanticAction,
  context: TuiRuntimeContext,
): TuiTransition {
  switch (action.type) {
    case "dashboard.addProject":
      return handleFirstProjectAddAction(state, context);
    case "dashboard.projectHeader.activate":
      return activateProjectHeaderControl(state, action.projectId, action.actionId);
    case "dashboard.emptyProject.activate":
      return activateEmptyProjectAction(state, action.projectId);
    case "addProject.activate":
      return handleAddProjectAction(state, action.actionId);
    case "newSession.activate":
      return handleNewSessionAction(state, action.actionId);
    case "removeWorktree.activate":
      return handleRemoveWorktreeAction(state, action.actionId);
    case "forkSession.activate":
      return handleForkSessionAction(state, action.actionId);
    case "renameSession.submit":
      return submitRenameSession(state);
  }
}
