import type { ProjectId, SessionId } from "@station/contracts";
import type { AddProjectActionId } from "../flows/addProject/actions.js";
import type { NewSessionActionId } from "../flows/newSession.js";
import type { DashboardCellId, DashboardRowId } from "../selectors/dashboardTree.js";
import type { ClientNotice } from "../services/types.js";
import { activateDashboardCell } from "./dashboardCells.js";
import { scrollDashboard } from "./dashboardScroll.js";
import type { TuiKey } from "./keys.js";
import { openDashboardRowShell } from "./rowActivation.js";
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
import type { TuiRuntimeContext, TuiTransition } from "./transition.js";
import type {
  DashboardFilterConditionField,
  DashboardState,
  ProjectSettingsItemId,
} from "./types.js";

/**
 * The void-returning closed mutation and effect surface for dashboard consumers.
 *
 * Semantic execution is fully owned by the runtime and its injected capabilities;
 * callers cannot intercept renderer metadata or mutate optimistic rows directly.
 */
export type DashboardActions = {
  /** Apply one translated key through the pure transition and runtime effect path. */
  handleKey(key: TuiKey): void;
  /** Resolve one typed action through the shared transition and runtime effect path. */
  dispatch(action: DashboardAction): void;
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
};

export type PersistentFilterActionId = "persistentFilter.edit" | "persistentFilter.clear";

/** User-interaction subset of {@link DashboardAction}, shared by pointer and keyboard activation. */
export type TuiSemanticAction =
  | { type: "dashboard.addProject" }
  | { type: "dashboard.cell.activate"; rowId: DashboardRowId; cellId: DashboardCellId }
  | { type: "dashboard.rowShell.open"; rowId: SessionId }
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
  | { type: "addProject.activate"; actionId: AddProjectActionId }
  | { type: "newSession.activate"; actionId: NewSessionActionId }
  | { type: "removeWorktree.activate"; actionId: RemoveWorktreeActionId }
  | { type: "forkSession.activate"; actionId: ForkSessionActionId }
  | { type: "renameSession.submit" };

/** State-only dashboard events for focus, screen, selection, scrolling, and widget transitions. */
export type DashboardStateAction =
  | { type: "dashboard.scroll"; delta: number }
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
  state: DashboardState,
  action: DashboardAction,
  context: TuiRuntimeContext,
): TuiTransition {
  switch (action.type) {
    case "dashboard.addProject":
      return handleFirstProjectAddAction(state, context);
    case "dashboard.cell.activate":
      return activateDashboardCell(state, action.rowId, action.cellId);
    case "dashboard.rowShell.open":
      return openDashboardRowShell(state, action.rowId);
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

function handleDashboardStateAction(
  state: DashboardState,
  action: DashboardStateAction,
): TuiTransition {
  switch (action.type) {
    case "dashboard.scroll":
      return stateTransition(scrollDashboard(state, action.delta));
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
  state: DashboardState,
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
  state: DashboardState,
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

function stateTransition(state: DashboardState): TuiTransition {
  return { state };
}
