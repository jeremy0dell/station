/**
 * Role entrypoint: dashboard state views, keys, screens, and flows.
 *
 * Read-only state projections, key/action handling, screen transitions,
 * toasts, Project-menu/Create-Group actions, and the new-session/add-project flow machines. Mutable internal
 * state models are not exported here; they remain private to the runtime
 * implementation and its focused tests.
 */

export type { AddProjectActionId } from "../flows/addProject/actions.js";
export { addProjectActions } from "../flows/addProject/actions.js";

export {
  createAddProjectFlow,
  transitionAddProjectFlow,
} from "../flows/addProject/flow.js";

export { addProjectRows } from "../flows/addProject/rows.js";

export type { AddProjectFlowStateView } from "../flows/addProject/types.js";
export type {
  NewSessionActionId,
  NewSessionFlowStateView,
} from "../flows/newSession.js";
export {
  createNewSessionFlow,
  selectedProject,
  transitionNewSessionFlow,
} from "../flows/newSession.js";

export type {
  PersistentFilterActionId,
  TuiSemanticAction,
} from "../state/actions.js";
export type { TuiInputMode } from "../state/keymap.js";
export {
  deriveTuiInputMode,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
} from "../state/keymap.js";

export type { TuiKey } from "../state/keys.js";

export { addPendingProjectDefaultHarness } from "../state/localRows.js";

export { createInitialTuiState } from "../state/screen.js";

export { tuiScreenBehavior } from "../state/screenBehavior.js";

export {
  applyAddProjectFolderLoaded,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectSubmitted,
} from "../state/screens/addProjectScreen.js";

export type { ForkSessionActionId } from "../state/screens/fork.js";

export { openProjectDefaultAgentPicker } from "../state/screens/projectDefaultAgent.js";
export {
  isRemoveProjectArmed,
  openProjectSettings,
  PROJECT_SETTINGS_AGENT_LIST_ID,
  PROJECT_SETTINGS_ITEMS,
  removeProjectConfirmPhrase,
} from "../state/screens/projectSettings.js";
export type { RemoveWorktreeActionId } from "../state/screens/removeWorktree.js";
export {
  isExternalAgentRemovalUnavailable,
  openRemoveWorktreeConfirmForRow,
} from "../state/screens/removeWorktree.js";
export type { ProjectMenuInputActionId } from "../state/screens/sessionGroups.js";
export {
  openCreateGroup,
  openProjectMenu,
  submitCreateSessionGroup,
  submitQuickGroup,
} from "../state/screens/sessionGroups.js";

export {
  ADD_PROJECT_CHOOSE_LIST_ID,
  addProjectSelectedIndex,
  addProjectSelectedIndexForFlow,
} from "../state/selection/addProject.js";

export { LIST_REGISTRY } from "../state/selection/registry.js";

export type { TuiSelectionState } from "../state/selection/types.js";

export {
  activeTuiToast,
  isTuiToastHiddenByScreen,
  nextTuiToastExpiry,
} from "../state/toasts.js";

export { handleTuiKey } from "../state/transition.js";

export type {
  CreateGroupFocus,
  CreateGroupReturnTarget,
  CreateGroupScreenView,
  DashboardFilterConditionField,
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardStateView,
  DashboardViewState,
  ProjectMenuActionId,
  ProjectMenuScreenView,
  ProjectSettingsItemId,
  TuiToastEntry,
  WidgetSettingsFocus,
} from "../state/types.js";
