import type { ProjectId, SessionId } from "@station/contracts";
import type { AddProjectActionId } from "../flows/addProject/actions.js";
import type { NewSessionActionId } from "../flows/newSession.js";
import { focusDashboardProjectHeader } from "./dashboardFocus.js";
import { scrollDashboard } from "./dashboardScroll.js";
import {
  activateEmptyProjectAction,
  activateProjectHeaderControl,
} from "./projectHeaderActions.js";
import { tuiScreenBehavior } from "./screenBehavior.js";
import { handleAddProjectAction, selectAddProjectRow } from "./screens/addProjectScreen.js";
import { handleFirstProjectAddAction } from "./screens/dashboard.js";
import {
  type ForkSessionActionId,
  handleForkSessionAction,
  openForkDetailsForRow,
} from "./screens/fork.js";
import { handleNewSessionAction } from "./screens/newSession.js";
import { openProjectDefaultAgentPicker } from "./screens/projectDefaultAgent.js";
import { focusProjectSettingsItem, openProjectSettings } from "./screens/projectSettings.js";
import {
  handleRemoveWorktreeAction,
  openRemoveWorktreeConfirmForRow,
  type RemoveWorktreeActionId,
} from "./screens/removeWorktree.js";
import { submitRenameSession } from "./screens/renameSession.js";
import { openRenameEditForRow } from "./screens/sessionRows.js";
import {
  openWidgetSettings,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
} from "./screens/widgetSettings.js";
import type { TuiRuntimeContext, TuiTransition } from "./transition.js";
import type { ProjectHeaderControl, ProjectSettingsItemId, TuiState } from "./types.js";

/** User-interaction subset of {@link DashboardAction}, shared by pointer and keyboard activation. */
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

/** State-only dashboard events for focus, screen, selection, scrolling, and widget transitions. */
export type DashboardStateAction =
  | { type: "dashboard.scroll"; delta: number }
  | {
      type: "dashboard.projectHeader.focus";
      projectId: ProjectId;
      control: ProjectHeaderControl;
    }
  | { type: "projectSettings.focusItem"; itemId: ProjectSettingsItemId }
  | { type: "addProject.selectRow"; index: number }
  | { type: "screen.clickAway" }
  | { type: "renameSession.openEdit"; rowId: SessionId; returnTo: "dashboard" }
  | { type: "removeWorktree.openConfirm"; rowId: SessionId }
  | { type: "projectDefaultAgent.open"; projectId: ProjectId }
  | { type: "projectSettings.open"; projectId: ProjectId }
  | { type: "forkSession.openDetails"; rowId: SessionId; returnTo: "dashboard" }
  | { type: "widgetSettings.open" }
  | { type: "widgetSettings.toggle"; index: number }
  | { type: "widgetSettings.remove"; index: number }
  | { type: "widgetSettings.openPicker" }
  | { type: "widgetSettings.addFromPicker"; index: number };

/** Closed renderer-neutral action/event set accepted by dashboard state. */
export type DashboardAction = TuiSemanticAction | DashboardStateAction;

/** Resolves a dashboard action through the same pure transition model used by keyboard input. */
export function handleTuiAction(
  state: TuiState,
  action: DashboardAction,
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
    default:
      return handleDashboardStateAction(state, action);
  }
}

function handleDashboardStateAction(state: TuiState, action: DashboardStateAction): TuiTransition {
  switch (action.type) {
    case "dashboard.scroll":
      return stateTransition(scrollDashboard(state, action.delta));
    case "dashboard.projectHeader.focus":
      return stateTransition(focusDashboardProjectHeader(state, action.projectId, action.control));
    case "projectSettings.focusItem":
      return stateTransition(focusProjectSettingsItem(state, action.itemId));
    case "addProject.selectRow":
      return stateTransition(selectAddProjectRow(state, action.index));
    case "screen.clickAway":
    case "renameSession.openEdit":
    case "removeWorktree.openConfirm":
    case "projectDefaultAgent.open":
    case "projectSettings.open":
    case "forkSession.openDetails":
      return handleDashboardScreenAction(state, action);
    default:
      return handleDashboardWidgetAction(state, action);
  }
}

function handleDashboardScreenAction(
  state: TuiState,
  action: Extract<
    DashboardStateAction,
    | { type: "screen.clickAway" }
    | { type: "renameSession.openEdit" }
    | { type: "removeWorktree.openConfirm" }
    | { type: "projectDefaultAgent.open" }
    | { type: "projectSettings.open" }
    | { type: "forkSession.openDetails" }
  >,
): TuiTransition {
  switch (action.type) {
    case "screen.clickAway": {
      const clickAway = tuiScreenBehavior(state.screen).clickAway;
      return stateTransition(clickAway === undefined ? state : clickAway(state));
    }
    case "renameSession.openEdit":
      return stateTransition(
        openRenameEditForRow(state, action.rowId, { returnTo: action.returnTo }),
      );
    case "removeWorktree.openConfirm":
      return stateTransition(openRemoveWorktreeConfirmForRow(state, action.rowId));
    case "projectDefaultAgent.open":
      return stateTransition(openProjectDefaultAgentPicker(state, action.projectId));
    case "projectSettings.open":
      return stateTransition(openProjectSettings(state, action.projectId));
    case "forkSession.openDetails":
      return stateTransition(
        openForkDetailsForRow(state, action.rowId, { returnTo: action.returnTo }),
      );
    default:
      return assertNeverAction(action);
  }
}

function handleDashboardWidgetAction(
  state: TuiState,
  action: Extract<DashboardStateAction, { type: `widgetSettings.${string}` }>,
): TuiTransition {
  switch (action.type) {
    case "widgetSettings.open":
      return stateTransition(openWidgetSettings(state));
    case "widgetSettings.toggle":
      return stateTransition(widgetSettingsToggleAt(state, action.index));
    case "widgetSettings.remove":
      return stateTransition(widgetSettingsRemoveAt(state, action.index));
    case "widgetSettings.openPicker":
      return stateTransition(widgetSettingsOpenPicker(state));
    case "widgetSettings.addFromPicker":
      return stateTransition(widgetSettingsAddFromPicker(state, action.index));
    default:
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(`Unhandled dashboard action: ${JSON.stringify(action)}`);
}

function stateTransition(state: TuiState): TuiTransition {
  return { state };
}
