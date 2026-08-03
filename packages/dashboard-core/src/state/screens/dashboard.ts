import { createNewSessionFlow, createNewSessionNameToken } from "../../flows/newSession.js";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import {
  activateFocusedDashboardRow,
  focusedEmptyProjectAction,
  focusedProjectHeaderControl,
  focusNextNeedsMe,
  moveDashboardFocus,
  moveDashboardFocusHorizontal,
} from "../dashboardFocus.js";
import { scrollDashboard } from "../dashboardScroll.js";
import type { DashboardSearchExperience } from "../experiences/dashboardSearch.js";
import { matchDashboardBinding, type TuiDashboardAction } from "../keymap.js";
import type { TuiKey } from "../keys.js";
import {
  activateEmptyProjectAction,
  activateProjectHeaderControl,
} from "../projectHeaderActions.js";
import { activateDashboardRow } from "../rowActivation.js";
import { addTuiToast } from "../toasts.js";
import type { TuiRuntimeContext, TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { openAddProject } from "./addProjectScreen.js";
import { clearDashboardPersistentFilter } from "./persistentFilter.js";
import { openProjectSlotPicker } from "./projectSlotPicker.js";
import { openWidgetSettings } from "./widgetSettings.js";

export const dashboardScreenBehavior = {};

export function handleDashboardKey(
  state: TuiState,
  key: TuiKey,
  context: TuiRuntimeContext,
  dashboardSearchExperience: DashboardSearchExperience,
): TuiTransition {
  const mouseScrollDelta = mouseScrollDeltaForKey(key);
  if (mouseScrollDelta !== 0) {
    return {
      state: scrollDashboard(state, mouseScrollDelta),
    };
  }

  const binding = matchDashboardBinding(key);
  if (binding === undefined) {
    return { state };
  }

  return handleDashboardAction(state, binding.action, context, key, dashboardSearchExperience);
}

function handleDashboardAction(
  state: TuiState,
  action: TuiDashboardAction,
  context: TuiRuntimeContext,
  key: TuiKey,
  dashboardSearchExperience: DashboardSearchExperience,
): TuiTransition {
  switch (action) {
    case "tui.focus.up":
      return {
        state: moveDashboardFocus(state, -1),
      };
    case "tui.focus.down":
      return {
        state: moveDashboardFocus(state, 1),
      };
    case "tui.focus.left":
      return {
        state: moveDashboardFocusHorizontal(state, -1),
      };
    case "tui.focus.right":
      return {
        state: moveDashboardFocusHorizontal(state, 1),
      };
    case "tui.focus.activate": {
      if (hasNoProjects(state)) {
        return handleDashboardAddProjectAction(state, context);
      }
      const emptyProject = focusedEmptyProjectAction(state);
      if (emptyProject !== undefined) {
        return activateEmptyProjectAction(state, emptyProject.projectId);
      }
      const header = focusedProjectHeaderControl(state);
      return header === undefined
        ? activateFocusedDashboardRow(state)
        : activateProjectHeaderControl(state, header.projectId, header.control);
    }
    case "tui.focus.nextNeedsMe":
      return {
        state: focusNextNeedsMe(state),
      };
    case "tui.help.open":
      return {
        state: {
          ...state,
          screen: { name: "help" },
        },
      };
    case "tui.exit":
      return exitOrDismissPopup(state);
    case "tui.popup.dismiss": {
      if (state.persistentFilter !== undefined) {
        return clearDashboardPersistentFilter(state);
      }
      return state.runtime.persistentPopup && state.runtime.canDismissPopup
        ? { state, dismissPopup: true }
        : { state };
    }
    case "tui.search.open":
      return dashboardSearchExperience.open(state);
    case "tui.rename.open":
      return {
        state: {
          ...state,
          screen: { name: "renameSession", step: "chooseSlot" },
        },
      };
    case "tui.fork.open":
      return {
        state: {
          ...state,
          screen: { name: "fork", step: "chooseSlot" },
        },
      };
    case "tui.refresh":
      return {
        state,
        reconcileReason: "tui-refresh",
      };
    case "tui.remove.open":
      return {
        state: {
          ...state,
          screen: { name: "removeWorktree", step: "chooseSlot" },
        },
      };
    case "tui.newSession.open":
      return openNewSession(state);
    case "tui.addProject.open":
      return handleDashboardAddProjectAction(state, context);
    case "tui.collapse.open":
      return openProjectSlotPicker(state, "projectCollapse");
    case "tui.projectSettings.openPicker":
      return openProjectSlotPicker(state, "projectSettingsPicker");
    case "tui.widgetSettings.open":
      return { state: openWidgetSettings(state) };
    case "tui.row.activateSlot":
      return activateDashboardSlot(state, key);
    default:
      return assertNever(action);
  }
}

/** Executes dashboard Add Project intent independently of the input modality. */
export function handleDashboardAddProjectAction(
  state: TuiState,
  context: TuiRuntimeContext,
): TuiTransition {
  if (state.screen.name !== "dashboard") return { state };
  return {
    state: openAddProject(state, { ...context, firstProject: hasNoProjects(state) }),
  };
}

/** Keeps stale first-project targets inert after the dashboard gains a project. */
export function handleFirstProjectAddAction(
  state: TuiState,
  context: TuiRuntimeContext,
): TuiTransition {
  return hasNoProjects(state) ? handleDashboardAddProjectAction(state, context) : { state };
}

function hasNoProjects(state: TuiState): boolean {
  return state.snapshot?.projects.length === 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled dashboard binding: ${JSON.stringify(value)}`);
}

function exitOrDismissPopup(state: TuiState): TuiTransition {
  if (state.runtime.persistentPopup && state.runtime.canDismissPopup) {
    return {
      state,
      dismissPopup: true,
    };
  }

  return {
    state,
    exitCode: 0,
  };
}

function activateDashboardSlot(state: TuiState, key: TuiKey): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const row = choiceValueByKey(
    selectDashboardViewport(state.snapshot, state).rowChoices,
    key.input,
  );
  if (row === undefined) {
    return { state };
  }

  return activateDashboardRow(state, row);
}

function mouseScrollDeltaForKey(key: TuiKey): -1 | 0 | 1 {
  if (key.mouseScroll === "up") {
    return -1;
  }
  if (key.mouseScroll === "down") {
    return 1;
  }
  return 0;
}

function openNewSession(state: TuiState): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const flow = createNewSessionFlow(state.snapshot, createNewSessionNameToken());
  if (flow === undefined) {
    return {
      state: addTuiToast(
        state,
        safeErrorToToast({
          tag: "CommandValidationError",
          code: "PROJECT_NOT_CONFIGURED",
          message: "No project is configured for a new session.",
          hint: "Add a project to config.toml and run station reconcile.",
        }),
      ),
    };
  }

  return {
    state: {
      ...state,
      screen: { name: "newSession", flow },
    },
  };
}
