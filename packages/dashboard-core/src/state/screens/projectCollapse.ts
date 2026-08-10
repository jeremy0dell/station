import type { ProjectId } from "@station/contracts";
import { reconcileDashboardFocus } from "../dashboardFocus.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

export const projectCollapseScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeProjectCollapse,
};

// Slot/↑↓/↵/mouse are handled by the shared selectionMiddleware
// (projectCollapseListSpec); only esc-to-dashboard stays bespoke.
export function handleProjectCollapseKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectCollapse") {
    return { state };
  }
  if (key.escape === true) {
    return { state: closeProjectCollapse(state) };
  }
  return { state };
}

/** Toggles one current project and reconciles any cursor hidden by the collapse. */
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
  return reconcileDashboardFocus(state, { ...state, collapsedProjectIds });
}

function closeProjectCollapse(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}
