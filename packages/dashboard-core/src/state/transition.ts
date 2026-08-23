import type { TuiKey } from "./keys.js";
import type { DashboardVisibleRowsSource } from "./layoutVisibility.js";
import type { TuiOperation } from "./operations/types.js";
import { handleAddProjectKey } from "./screens/addProjectScreen.js";
import { handleDashboardKey } from "./screens/dashboard.js";
import { handleForkKey } from "./screens/fork.js";
import { handleFreshStartKey } from "./screens/freshStart.js";
import { handleGroupMenuKey } from "./screens/groupMenu.js";
import { handleGroupSettingsKey } from "./screens/groupSettings.js";
import { handleHelpKey } from "./screens/help.js";
import { handleMoveToGroupKey } from "./screens/moveToGroup.js";
import { handleNewSessionKey } from "./screens/newSession.js";
import { handleDashboardPersistentFilterKey } from "./screens/persistentFilter.js";
import { handleProjectCollapseKey } from "./screens/projectCollapse.js";
import { handleProjectDefaultAgentKey } from "./screens/projectDefaultAgent.js";
import { handleProjectSettingsKey } from "./screens/projectSettings.js";
import { handleProjectSettingsPickerKey } from "./screens/projectSettingsPicker.js";
import { handleRemoveWorktreeKey } from "./screens/removeWorktree.js";
import { handleRenameSessionKey } from "./screens/renameSession.js";
import { handleCreateGroupKey, handleProjectMenuKey } from "./screens/sessionGroups.js";
import { handleWidgetSettingsKey } from "./screens/widgetSettings.js";
import { selectionMiddleware } from "./selection/middleware.js";
import { activeTuiToast, isTuiToastHiddenByScreen } from "./toasts.js";
import type { DashboardState } from "./types.js";

export type TuiTransition = {
  state: DashboardState;
  operations?: TuiOperation[];
  reconcileReason?: string;
};

export type TuiRuntimeContext = {
  cwd: string;
  homeDir: string;
  visibleDashboardRows?: DashboardVisibleRowsSource;
};

export function handleTuiKey(
  state: DashboardState,
  key: TuiKey,
  context: TuiRuntimeContext = { cwd: process.cwd(), homeDir: process.env.HOME ?? "" },
): TuiTransition {
  if (key.ctrl === true && key.input === "c") {
    return {
      state,
      operations: [{ type: "exitDashboardRenderer", exitCode: 0 }],
    };
  }

  const activeToast = activeTuiToast(state);
  if (
    key.escape === true &&
    activeToast?.toast.kind === "error" &&
    !isTuiToastHiddenByScreen(state.screen)
  ) {
    return {
      state: {
        ...state,
        toasts: [],
      },
    };
  }

  // Registered lists resolve ↑↓/↵/slot here; an unregistered screen yields
  // undefined and keeps its bespoke reducer below.
  const selected = selectionMiddleware(state, key);
  if (selected !== undefined) {
    return selected;
  }

  switch (state.screen.name) {
    case "dashboard":
      return handleDashboardKey(state, key, context);
    case "help":
      return handleHelpKey(state, key);
    case "projectMenu":
      return handleProjectMenuKey(state, key);
    case "groupMenu":
      return handleGroupMenuKey(state, key);
    case "createGroup":
      return handleCreateGroupKey(state, key);
    case "persistentFilter":
      return handleDashboardPersistentFilterKey(state, key);
    case "projectCollapse":
      return handleProjectCollapseKey(state, key);
    case "projectSettingsPicker":
      return handleProjectSettingsPickerKey(state, key);
    case "freshStart":
      return handleFreshStartKey(state, key);
    case "removeWorktree":
      return handleRemoveWorktreeKey(state, key, context.visibleDashboardRows);
    case "renameSession":
      return handleRenameSessionKey(state, key, context.visibleDashboardRows);
    case "moveToGroup":
      return handleMoveToGroupKey(state, key, context.visibleDashboardRows);
    case "fork":
      return handleForkKey(state, key, context.visibleDashboardRows);
    case "newSession":
      return handleNewSessionKey(state, key);
    case "projectDefaultAgent":
      return handleProjectDefaultAgentKey(state, key);
    case "projectSettings":
      return handleProjectSettingsKey(state, key);
    case "groupSettings":
      return handleGroupSettingsKey(state, key);
    case "addProject":
      return handleAddProjectKey(state, key);
    case "widgetSettings":
      return handleWidgetSettingsKey(state, key);
  }
}
