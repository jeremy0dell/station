/**
 * Role entrypoint: dashboard selectors and view models.
 *
 * Pure projections from the readonly state view and canonical snapshot into
 * rows, viewport, header/footer/filter models, and layout primitives. No
 * mutation, lifecycle, or effects live here.
 */

export {
  bottomSheetContentWidth,
  bottomSheetFrameLayout,
} from "../components/BottomSheetFrame/layout.js";

export {
  commandPromptLineForScreen,
  commandPromptRows,
  emptyProjectLabel,
  FIRST_RUN_BODY_LABEL,
  fleetCountsLabel,
  headerStrip,
  observerHeaderStatusForConnection,
  projectHeaderLabelParts,
  scrollIndicatorLabel,
  snapshotLoadingLines,
} from "../components/Dashboard/content.js";
export type {
  DashboardFilterConditionPanelAction,
  DashboardFilterConditionPanelRow,
} from "../components/Dashboard/filterConditionPanel.js";
export { dashboardFilterConditionPanelModel } from "../components/Dashboard/filterConditionPanel.js";
export type {
  DashboardFilterFooterSegment,
  DashboardFooterModel,
} from "../components/Dashboard/footer.js";
export { dashboardFooterModel } from "../components/Dashboard/footer.js";
export { dashboardBodyTop, dashboardScrollGutterChrome } from "../components/Dashboard/layout.js";
export { dashboardRowGridInput } from "../components/Dashboard/rowGridInput.js";
export type {
  DashboardFilterHeaderModel,
  DashboardFilterHeaderSegment,
  DashboardTableHeaderModel,
} from "../components/Dashboard/tableHeader.js";
export {
  dashboardPersistentFilterHeaderModel,
  dashboardTableHeaderModel,
} from "../components/Dashboard/tableHeader.js";
export type { EditableTextInputState } from "../components/EditableTextInput/editing.js";
export {
  clampEditableTextCursor,
  createEditableTextInputState,
} from "../components/EditableTextInput/editing.js";
export type {
  CreateGroupActionId,
  CreateGroupControlContent,
  CreateGroupSheetContent,
} from "../components/GroupCreateSheet/content.js";
export { createGroupSheetContent } from "../components/GroupCreateSheet/content.js";

export {
  helpOverlayContent,
  helpOverlayLineCount,
} from "../components/HelpOverlay/content.js";
export type {
  HelpPanelBodyLine,
  HelpPanelLine,
  HelpPanelModel,
} from "../components/HelpOverlay/helpPanel.js";
export {
  clampHelpScrollOffset,
  helpPanelBodyRows,
  helpPanelLayout,
  helpPanelLines,
  helpPanelModel,
  joinHelpPanelLine,
} from "../components/HelpOverlay/helpPanel.js";
export {
  newSessionEditGroupDraftContent,
  newSessionEditNameContent,
  newSessionReviewContent,
} from "../components/NewSessionBottomSheet/content.js";
export { newSessionContentRowCount } from "../components/NewSessionBottomSheet/layout.js";
export { projectSettingsPanelLayout } from "../components/ProjectSettingsPanel/layout.js";
export {
  scrollbarOffsetForTrackIndex,
  VERTICAL_SCROLLBAR_EMPTY,
  VERTICAL_SCROLLBAR_THUMB,
  verticalScrollbarCells,
} from "../components/scrollbar.js";

export { textMatchSegments } from "../components/TextMatch/segments.js";
export type { ToastBorderColorName } from "../components/ToastOverlay/content.js";
export {
  toastBorderColor,
  toastCopyText,
  toastDetail,
  toastTitle,
} from "../components/ToastOverlay/content.js";

export { toastOverlayLayout } from "../components/ToastOverlay/layout.js";
export type { WidgetSettingsLine } from "../components/WidgetSettingsPanel/content.js";
export {
  widgetSettingsPanelLayout,
  widgetSettingsPanelModel,
} from "../components/WidgetSettingsPanel/content.js";
export type {
  RowColor,
  RowGridLayout,
  RowGridRowInput,
  RowSegment,
} from "../components/WorktreeRow/layout.js";
export {
  cellWidth,
  layoutWorktreeRowGrid,
  textSegment,
  truncateCells,
} from "../components/WorktreeRow/layout.js";

export { isReadyToRead } from "../selectors/agentStatus.js";

export {
  DASHBOARD_FILTER_CONDITION_KEYS,
  dashboardPersistentFilterSummarySegments,
} from "../selectors/dashboardFilterConditions.js";

export type {
  DashboardPersistentFilterGroupMatch,
  DashboardPersistentFilterProjection,
  DashboardPersistentFilterProjectMatch,
} from "../selectors/dashboardPersistentFilter.js";
export type { DashboardSessionRow } from "../selectors/dashboardSessionRows.js";
export {
  selectDashboardSessionRows,
  sessionRowDisplayTitle,
} from "../selectors/dashboardSessionRows.js";
export type {
  DashboardCellId,
  DashboardGroupFrameEndPayload,
  DashboardGroupHeaderPayload,
  DashboardRowId,
  DashboardTreeRow,
  GroupOrderingMode,
} from "../selectors/dashboardTree.js";
export { dashboardRowIds } from "../selectors/dashboardTree.js";
export type {
  DashboardSessionOverflow,
  DashboardViewport,
} from "../selectors/dashboardViewport.js";
export { selectDashboardViewport } from "../selectors/dashboardViewport.js";
export type { FleetSummary } from "../selectors/fleetSummary.js";
export { selectFleetSummary } from "../selectors/fleetSummary.js";
export type {
  KeyedChoice,
  MoveToGroupSessionContext,
  NewSessionGroupOption,
  NewSessionHarnessOption,
} from "../selectors/selectors.js";
export {
  selectMoveToGroupChoices,
  selectMoveToGroupSessionContext,
  selectNewSessionGroupChoices,
  selectNewSessionHarnessChoices,
  selectNewSessionProjectChoices,
  selectProjectChooserChoices,
  selectProjectDefaultHarness,
} from "../selectors/selectors.js";
