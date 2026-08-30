import { selectDashboardSlots } from "../../selectors/dashboardSlots.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { activateFocusedDashboardCell } from "../dashboardCells.js";
import {
  focusNextNeedsMe,
  moveDashboardCursor,
  moveDashboardCursorHorizontal,
} from "../dashboardFocus.js";
import { matchDashboardBinding, type TuiDashboardAction } from "../keymap.js";
import type { TuiKey } from "../keys.js";
import { activateDashboardRow } from "../rowActivation.js";
import type { TuiRuntimeContext, TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";
import { openAddProject } from "./addProjectScreen.js";
import { openNewSession } from "./newSession.js";
import {
  clearDashboardPersistentFilter,
  openDashboardPersistentFilter,
} from "./persistentFilter.js";
import { openProjectSlotPicker } from "./projectSlotPicker.js";
import { submitQuickGroup } from "./sessionGroups.js";
import { openWidgetSettings } from "./widgetSettings.js";

export const dashboardScreenBehavior = { dashboardHoverEnabled: true };

export function handleDashboardKey(
  state: DashboardState,
  key: TuiKey,
  context: TuiRuntimeContext,
): TuiTransition {
  if (key.mouseScroll !== undefined) return { state };

  const binding = matchDashboardBinding(key);
  if (binding === undefined) {
    return { state };
  }

  return handleDashboardAction(state, binding.action, context, key);
}

function handleDashboardAction(
  state: DashboardState,
  action: TuiDashboardAction,
  context: TuiRuntimeContext,
  key: TuiKey,
): TuiTransition {
  switch (action) {
    case "tui.focus.up":
      return {
        state: moveDashboardCursor(state, -1, context.visibleDashboardRows?.visibleRowIds()),
      };
    case "tui.focus.down":
      return {
        state: moveDashboardCursor(state, 1, context.visibleDashboardRows?.visibleRowIds()),
      };
    case "tui.focus.left":
      return {
        state: moveDashboardCursorHorizontal(state, -1),
      };
    case "tui.focus.right":
      return {
        state: moveDashboardCursorHorizontal(state, 1),
      };
    case "tui.focus.activate": {
      if (hasNoProjects(state)) {
        return handleDashboardAddProjectAction(state, context);
      }
      return activateFocusedDashboardCell(state);
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
      return exitDashboardRenderer(state);
    case "tui.popup.dismiss": {
      if (state.persistentFilter !== undefined) {
        return clearDashboardPersistentFilter(state);
      }
      return { state, operations: [{ type: "dismissDashboard" }] };
    }
    case "tui.filter.open":
      return openDashboardPersistentFilter(state);
    case "tui.rename.open":
      return {
        state: {
          ...state,
          screen: { name: "renameSession", step: "chooseSlot" },
        },
      };
    case "tui.moveToGroup.open":
      return {
        state: {
          ...state,
          screen: { name: "moveToGroup", step: "chooseSlot" },
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
    case "tui.quickGroup.create":
      return submitQuickGroup(state);
    case "tui.addProject.open":
      return handleDashboardAddProjectAction(state, context);
    case "tui.collapse.open":
      return openProjectSlotPicker(state, "projectCollapse");
    case "tui.projectSettings.openPicker":
      return openProjectSlotPicker(state, "projectSettingsPicker");
    case "tui.widgetSettings.open":
      return { state: openWidgetSettings(state) };
    case "tui.row.activateSlot":
      return activateDashboardSlot(state, key, context);
    default:
      return assertNever(action);
  }
}

/** Executes dashboard Add Project intent independently of the input modality. */
export function handleDashboardAddProjectAction(
  state: DashboardState,
  context: TuiRuntimeContext,
): TuiTransition {
  if (state.screen.name !== "dashboard") return { state };
  return {
    state: openAddProject(state, { ...context, firstProject: hasNoProjects(state) }),
  };
}

/** Keeps stale first-project targets inert after the dashboard gains a project. */
export function handleFirstProjectAddAction(
  state: DashboardState,
  context: TuiRuntimeContext,
): TuiTransition {
  return hasNoProjects(state) ? handleDashboardAddProjectAction(state, context) : { state };
}

function hasNoProjects(state: DashboardState): boolean {
  return state.snapshot?.projects.length === 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled dashboard binding: ${JSON.stringify(value)}`);
}

function exitDashboardRenderer(state: DashboardState): TuiTransition {
  return {
    state,
    operations: [{ type: "exitDashboardRenderer", exitCode: 0 }],
  };
}

function activateDashboardSlot(
  state: DashboardState,
  key: TuiKey,
  context: TuiRuntimeContext,
): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const row = choiceValueByKey(
    selectDashboardSlots(
      state.snapshot,
      state,
      state.screen,
      context.visibleDashboardRows?.visibleRowIds(),
    ).rowChoices,
    key.input,
  );
  if (row === undefined) {
    return { state };
  }

  return activateDashboardRow(state, row);
}
