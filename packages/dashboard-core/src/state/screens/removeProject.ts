import { buildRemoveProjectCommand } from "../commandBuilders.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * Open the remove-project confirmation for a project header. Snapshots the
 * label into the screen so the sheet reads stable copy even if a reconcile
 * drops the project mid-confirm. Inert off the dashboard or for a missing
 * project (a stale right-click target).
 */
export function openRemoveProjectConfirmForProject(state: TuiState, projectId: string): TuiState {
  if (state.screen.name !== "dashboard") {
    return state;
  }
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return state;
  }
  return {
    ...state,
    screen: { name: "removeProject", projectId: project.id, label: project.label },
  };
}

export function handleRemoveProjectKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeProject") {
    return { state };
  }

  // Mirror the remove-worktree confirm: lowercase input without reading ctrl,
  // so Ctrl-N/Ctrl-Y cancel/confirm like their plain counterparts.
  const input = key.input.toLowerCase();
  if (input === "n" || key.escape === true || isReturnKey(key)) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (input !== "y") {
    return { state };
  }

  const projectId = state.screen.projectId;
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  return {
    state: { ...state, screen: { name: "dashboard" } },
    operations: [
      {
        type: "removeProject",
        command: buildRemoveProjectCommand({ projectId: project.id }),
      },
    ],
  };
}
