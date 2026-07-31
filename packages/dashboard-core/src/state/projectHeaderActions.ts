import type { ProjectId } from "@station/contracts";
import { resolveNewSessionProjectAvailability } from "../flows/newSession.js";
import { selectDashboardItems } from "../selectors/dashboardViewport.js";
import { safeErrorToToast } from "../services/errors/errors.js";
import { focusDashboardProjectHeader, reconcileDashboardFocus } from "./dashboardFocus.js";
import { openProjectDefaultAgentPicker } from "./screens/projectDefaultAgent.js";
import { addTuiToast } from "./toasts.js";
import type { TuiTransition } from "./transition.js";
import type { ProjectHeaderControl, TuiState } from "./types.js";

/** Activates one current project-header control after moving focus to that segment. */
export function activateProjectHeaderControl(
  state: TuiState,
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
        controlIntent: { type: "projectShell.open", projectId },
      };
    case "quickSession": {
      const resolution = resolveNewSessionProjectAvailability(
        focused.snapshot?.projects.find((candidate) => candidate.id === projectId),
      );
      if (resolution.kind === "missing") {
        return { state: focused };
      }
      if (resolution.kind === "blocked") {
        return { state: addTuiToast(focused, safeErrorToToast(resolution.error)) };
      }
      return {
        state: focused,
        controlIntent: { type: "quickSession.create", projectId },
      };
    }
    case "defaultAgent":
      return { state: openProjectDefaultAgentPicker(focused, projectId) };
  }
}

/**
 * Toggles one current project and normalizes focus/scroll for both header
 * activation and the existing C project picker.
 */
export function toggleDashboardProjectCollapsed(state: TuiState, projectId: ProjectId): TuiState {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return state;
  }
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const collapsing = !collapsedProjectIds.delete(project.id);
  if (collapsing) {
    collapsedProjectIds.add(project.id);
  }
  const next: TuiState = { ...state, collapsedProjectIds };
  const focus = state.dashboardFocus;
  const focusedSessionProjectId =
    focus?.kind === "session"
      ? state.snapshot?.sessions.find((session) => session.id === focus.sessionId)?.projectId
      : undefined;
  if (collapsing && focusedSessionProjectId === project.id) {
    return focusDashboardProjectHeader(next, project.id, "primary");
  }
  return reconcileDashboardFocus(state, next);
}

function hasVisibleProjectHeader(state: TuiState, projectId: ProjectId): boolean {
  return (
    state.snapshot !== undefined &&
    selectDashboardItems(state.snapshot, state).some(
      (item) => item.type === "projectHeader" && item.project.id === projectId,
    )
  );
}
