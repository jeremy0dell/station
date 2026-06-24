import { choiceValueByKey, selectProjectChoices } from "../../selectors/selectors.js";
import { clampDashboardStateScroll } from "../dashboardScroll.js";
import type { TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export function handleProjectCollapseKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectCollapse") {
    return { state };
  }

  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  if (state.snapshot === undefined) {
    return { state };
  }

  const project = choiceValueByKey(selectProjectChoices(state.snapshot, state), key.input);
  if (project === undefined) {
    return { state };
  }

  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  if (collapsedProjectIds.has(project.id)) {
    collapsedProjectIds.delete(project.id);
  } else {
    collapsedProjectIds.add(project.id);
  }

  return {
    state: clampDashboardStateScroll({
      ...state,
      collapsedProjectIds,
      screen: { name: "dashboard" },
    }),
  };
}
