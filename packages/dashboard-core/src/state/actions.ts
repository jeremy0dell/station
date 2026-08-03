import type { ProjectId, SafeError, SessionId } from "@station/contracts";
import type { AddProjectActionId } from "../flows/addProject/actions.js";
import type { NewSessionActionId } from "../flows/newSession.js";
import type { ClientNotice } from "../services/types.js";
import { focusDashboardProjectHeader } from "./dashboardFocus.js";
import { scrollDashboard } from "./dashboardScroll.js";
import type { TuiKey } from "./keys.js";
import type { PendingCreateSessionRow } from "./localRows.js";
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
import {
  applyDashboardPersistentFilter,
  clearDashboardPersistentFilter,
  openDashboardPersistentFilter,
} from "./screens/persistentFilter.js";
import {
  backPersistentFilterConditionEditor,
  cancelPersistentFilterConditionEditor,
  donePersistentFilterConditionEditor,
  selectPersistentFilterConditionField,
  togglePersistentFilterConditionValue,
} from "./screens/persistentFilterConditions.js";
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
import type { TuiControlIntent, TuiRuntimeContext, TuiTransition } from "./transition.js";
import type {
  DashboardFilterConditionField,
  ProjectHeaderControl,
  ProjectSettingsItemId,
  TuiState,
} from "./types.js";

/** Result of a dashboard action, including any one-shot renderer-owned control intent. */
export type DashboardActionResult = {
  dismissPopup: boolean;
  exitCode?: number;
  controlIntent?: TuiControlIntent;
};

/**
 * The sole external mutation authority for dashboard state.
 *
 * Actions apply dashboard transitions and effects without exposing the private
 * Zustand store or a generic state setter.
 */
export type DashboardActions = {
  /** Applies a key transition and returns any one-shot renderer-owned control intent. */
  handleKey(key: TuiKey): DashboardActionResult;
  /** Resolves typed actions through the shared transition and effect path. */
  dispatch(action: DashboardAction): DashboardActionResult;
  /** Create a project session immediately with its configured default harness. */
  createQuickSession(projectId: string): void;
  setTerminalRows(rows: number): void;
  /** Synchronize row focus from a canonical observer session identity. */
  focusDashboardSession(sessionId: SessionId): void;
  /** Remove transient row focus without changing other dashboard state. */
  clearDashboardFocus(): void;
  /** Surface a client-side toast (e.g. an unresolved-harness notice). */
  pushToast(toast: ClientNotice): void;
  dismissToasts(): void;
  expireToasts(nowMs?: number): void;
  refreshActiveToastExpiry(nowMs?: number): void;
  /** Adds a pending hosted-create row until its workspace lifecycle resolves. */
  addPendingCreateSession(row: PendingCreateSessionRow): void;
  /** Moves a pending row to retained failure; the caller owns expiry and scheduled removal. */
  failPendingCreateSession(localId: string, error: SafeError, expiresAt: number): void;
  /** Removes a pending or retained-failure hosted-create row by local identity. */
  removePendingCreateSession(localId: string): void;
};

export type PersistentFilterActionId = "persistentFilter.edit" | "persistentFilter.clear";

/** User-interaction subset of {@link DashboardAction}, shared by pointer and keyboard activation. */
export type TuiSemanticAction =
  | { type: "dashboard.addProject" }
  | { type: PersistentFilterActionId }
  | {
      type: "persistentFilter.condition.selectField";
      field: DashboardFilterConditionField;
    }
  | {
      type: "persistentFilter.condition.toggleValue";
      field: DashboardFilterConditionField;
      valueId: string;
    }
  | { type: "persistentFilter.condition.back" }
  | { type: "persistentFilter.condition.close" }
  | { type: "persistentFilter.condition.done" }
  | { type: "persistentFilter.applyDraft" }
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
    case "persistentFilter.edit":
      return openDashboardPersistentFilter(state);
    case "persistentFilter.clear":
      return clearDashboardPersistentFilter(state);
    case "persistentFilter.condition.selectField":
      return stateTransition(selectPersistentFilterConditionField(state, action.field));
    case "persistentFilter.condition.toggleValue":
      return stateTransition(
        togglePersistentFilterConditionValue(state, action.field, action.valueId),
      );
    case "persistentFilter.condition.back":
      return stateTransition(backPersistentFilterConditionEditor(state));
    case "persistentFilter.condition.close":
      return stateTransition(cancelPersistentFilterConditionEditor(state));
    case "persistentFilter.condition.done":
      return stateTransition(donePersistentFilterConditionEditor(state));
    case "persistentFilter.applyDraft":
      return applyDashboardPersistentFilter(state);
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
