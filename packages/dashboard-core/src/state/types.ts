import type {
  AgentState,
  ProjectId,
  ProviderId,
  SafeError,
  SessionGroupId,
  SessionId,
  StationSnapshot,
  TuiWidgetConfig,
  WorktreeId,
} from "@station/contracts";
import type { EditableTextInputState } from "../components/EditableTextInput/editing.js";
import type { AddProjectFlowState } from "../flows/addProject/types.js";
import type { NewSessionFlowState } from "../flows/newSession.js";
import type { DashboardFocus, GroupOrderingMode } from "../selectors/dashboardTree.js";
import type { ClientNotice } from "../services/types.js";
import type { TuiLocalRows } from "./localRows.js";
import type { ReadonlyDeep } from "./readonly.js";
import type { TuiSelectionState } from "./selection/types.js";

export type DashboardFilterConditionField = "status" | "project" | "agent";

export type DashboardFilterStatusConditionValue = {
  id: AgentState;
  label: string;
};

export type DashboardFilterProjectConditionValue = {
  id: ProjectId;
  label: string;
};

export type DashboardFilterAgentConditionValue = {
  id: ProviderId;
  label: string;
};

/**
 * Stable condition IDs pair with visible labels; values are ORed within a field while free text
 * and separate Status, Project, and Agent fields are ANDed in canonical field order.
 */
export type DashboardFilterCondition =
  | { field: "status"; values: readonly DashboardFilterStatusConditionValue[] }
  | { field: "project"; values: readonly DashboardFilterProjectConditionValue[] }
  | { field: "agent"; values: readonly DashboardFilterAgentConditionValue[] };

export type DashboardFilterConditionOption = {
  id: string;
  label: string;
};

export type DashboardFilterConditionEditor =
  | { stage: "field"; cursor: number }
  | {
      stage: "values";
      field: DashboardFilterConditionField;
      cursor: number;
      /** Frozen for the panel lifetime so snapshots cannot reassign visible slot keys. */
      options: readonly DashboardFilterConditionOption[];
      selectedIds: readonly string[];
    };

/** Dashboard-local applied free text plus normalized structured conditions. */
export type DashboardPersistentFilter = {
  /** Blank remains valid when at least one structured condition is selected. */
  query: string;
  /** Omitted is the normalized empty selection for query-only compatibility. */
  conditions?: readonly DashboardFilterCondition[];
};

export type TuiViewState = {
  /** Dashboard-local applied filter; absence means no persistent filter is applied. */
  persistentFilter?: DashboardPersistentFilter;
  collapsedProjectIds: ReadonlySet<string>;
  collapsedGroupIds: ReadonlySet<SessionGroupId>;
  groupOrderingMode: GroupOrderingMode;
  scrollOffset: number;
  terminalRows: number;
  localRows: TuiLocalRows;
  /** Branded dashboard row/cell cursor; native overlays synchronize session identity once per open. */
  dashboardFocus?: DashboardFocus;
  /** Per-list cursor for screens migrated onto the shared selection engine. */
  selection: TuiSelectionState;
};

/**
 * Private reducer/store data model owned by the dashboard runtime.
 *
 * External mutation is available only through {@link DashboardActions}; action
 * and lifecycle methods are never stored in dashboard snapshots.
 */
export type DashboardState = TuiViewState & {
  snapshot?: StationSnapshot;
  loading: boolean;
  screen: TuiScreen;
  toasts: TuiToastEntry[];
  observerConnectionStatus: TuiObserverConnectionStatus;
  /**
   * Live top-row widget set, seeded from `[tui].widgets`. Widget-settings
   * edits land here first and are written back to config.toml when a config
   * path exists.
   */
  widgets: readonly TuiWidgetConfig[];
  /** False when no config.toml path exists to write widget edits back to. */
  widgetsPersisted: boolean;
};

/** Recursively readonly public projection of the private dashboard store model. */
export type DashboardStateView = ReadonlyDeep<DashboardState>;

/** Readonly Observer snapshot exposed through {@link DashboardStateView}. */
export type DashboardSnapshotView = NonNullable<DashboardStateView["snapshot"]>;

/** Readonly active-screen projection exposed through {@link DashboardStateView}. */
export type DashboardScreenView = DashboardStateView["screen"];

/** Readonly dashboard presentation state shared by pure selectors. */
export type DashboardViewState = ReadonlyDeep<TuiViewState>;

export type TuiToastEntry = {
  id: string;
  toast: ClientNotice;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
};

export type TuiObserverConnectionStatus =
  | { state: "connected" }
  | { state: "reconnecting"; since: number; lastError?: SafeError }
  | { state: "displayOnly"; since: number; lastError?: SafeError };

export type TuiScreen =
  | { name: "dashboard" }
  | { name: "help" }
  | {
      name: "persistentFilter";
      draft: EditableTextInputState;
      draftConditions: readonly DashboardFilterCondition[];
      conditionEditor?: DashboardFilterConditionEditor;
    }
  | { name: "projectCollapse" }
  | { name: "projectSettingsPicker" }
  | { name: "removeWorktree"; step: "chooseSlot" }
  | { name: "removeWorktree"; step: "unavailable" }
  | {
      name: "removeWorktree";
      step: "confirm";
      rowId: SessionId;
      forceRequired: boolean;
      label: string;
      actionFocus: "delete" | "keep";
    }
  | { name: "renameSession"; step: "chooseSlot" }
  | {
      name: "renameSession";
      step: "editName";
      rowId: SessionId;
      sessionId: SessionId;
      currentTitle: string;
      draftTitle: EditableTextInputState;
      returnTo?: "dashboard";
      validationError?: string;
    }
  | { name: "fork"; step: "chooseSlot" }
  | {
      name: "fork";
      step: "details";
      sourceWorktreeId: WorktreeId;
      projectId: ProjectId;
      projectLabel: string;
      sourceBranch: string;
      sourceDirty: boolean;
      sourceAgentRunning: boolean;
      branch: string;
      draftTitle: EditableTextInputState;
      copyDirty: boolean;
      focus: "name" | "copyDirty" | "submit";
      returnTo?: "dashboard";
      validationError?: string;
    }
  | { name: "addProject"; flow: AddProjectFlowState }
  | { name: "newSession"; flow: NewSessionFlowState }
  | { name: "projectDefaultAgent"; projectId: ProjectId }
  | {
      name: "projectSettings";
      projectId: ProjectId;
      focus: ProjectSettingsFocus;
      activeId: ProjectSettingsItemId;
      removeDraft: EditableTextInputState;
    }
  | { name: "widgetSettings"; focus: WidgetSettingsFocus; cursor: number; pickerCursor: number };

/** Whether the widget list or the add-widget picker owns keyboard input. */
export type WidgetSettingsFocus = "list" | "picker";

/** Which pane of the two-pane settings panel owns keyboard input. */
export type ProjectSettingsFocus = "list" | "detail";
/** Left-list item ids; extend alongside the registry in screens/projectSettings.ts. */
export type ProjectSettingsItemId = "agent" | "remove";

export type CreateInitialTuiStateOptions = {
  initialSnapshot?: StationSnapshot;
  persistentFilter?: DashboardPersistentFilter;
  collapsedProjectIds?: Iterable<string>;
  collapsedGroupIds?: Iterable<SessionGroupId>;
  groupOrderingMode?: GroupOrderingMode;
  scrollOffset?: number;
  terminalRows?: number;
  localRows?: TuiLocalRows;
  dashboardFocus?: DashboardFocus;
  widgets?: readonly TuiWidgetConfig[];
  widgetsPersisted?: boolean;
};
