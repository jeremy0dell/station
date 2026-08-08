import type { ProjectId } from "@station/contracts";
import { selectDashboardItems } from "../selectors/dashboardViewport.js";
import {
  focusDashboardEmptyProjectAction,
  focusDashboardProjectHeader,
  reconcileDashboardFocus,
} from "./dashboardFocus.js";
import { openProjectDefaultAgentPicker } from "./screens/projectDefaultAgent.js";
import { submitQuickSession } from "./screens/quickSession.js";
import type { TuiTransition } from "./transition.js";
import type { DashboardState, ProjectHeaderControl } from "./types.js";

/** Activates one current project-header control after moving focus to that segment. */
export function activateProjectHeaderControl(
  state: DashboardState,
  projectId: ProjectId,
  actionId: ProjectHeaderControl,
): TuiTransition {
  if (state.screen.name !== "dashboard" || !hasVisibleProjectHeader(state, projectId)) {
    return { state };
  }
  const focused = focusDashboardProjectHeader(state, projectId, actionId);
  switch (actionId) {
    case "primary":
      return { state: toggleDashboardProjectCollapsed(focused, projectId) };
    case "shell":
      return {
        state: focused,
        operations: [{ type: "openDashboardShell", target: { kind: "project", projectId } }],
      };
    case "quickSession":
      return submitQuickSession(focused, projectId);
    case "defaultAgent":
      return { state: openProjectDefaultAgentPicker(focused, projectId) };
  }
}

/** Focus the rendered empty-project action before the shared Quick Session transition. */
export function activateEmptyProjectAction(
  state: DashboardState,
  projectId: ProjectId,
): TuiTransition {
  if (state.screen.name !== "dashboard" || !hasVisibleEmptyProject(state, projectId)) {
    return { state };
  }
  const transition = submitQuickSession(
    focusDashboardEmptyProjectAction(state, projectId),
    projectId,
  );
  return {
    ...transition,
    state: focusDashboardEmptyProjectAction(transition.state, projectId),
  };
}

/**
 * Toggles one current project and normalizes focus/scroll for both header
 * activation and the existing C project picker.
 */
export function toggleDashboardProjectCollapsed(
  state: DashboardState,
  projectId: ProjectId,
): DashboardState {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return state;
  }
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const collapsing = !collapsedProjectIds.delete(project.id);
  if (collapsing) {
    collapsedProjectIds.add(project.id);
  }
  const next: DashboardState = { ...state, collapsedProjectIds };
  return reconcileDashboardFocus(state, next);
}

function hasVisibleProjectHeader(state: DashboardState, projectId: ProjectId): boolean {
  return hasVisibleItem(state, projectId, "projectHeader");
}

function hasVisibleEmptyProject(state: DashboardState, projectId: ProjectId): boolean {
  return hasVisibleItem(state, projectId, "emptyProject");
}

function hasVisibleItem(
  state: DashboardState,
  projectId: ProjectId,
  type: "projectHeader" | "emptyProject",
): boolean {
  return (
    state.snapshot !== undefined &&
    selectDashboardItems(state.snapshot, state).some(
      (item) => item.type === type && item.project.id === projectId,
    )
  );
}
