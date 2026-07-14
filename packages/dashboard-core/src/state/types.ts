import type { TuiWidgetConfig } from "@station/config";
import type {
  ProjectId,
  SafeError,
  SessionId,
  StationSnapshot,
  TerminalFocusOrigin,
  WorktreeId,
} from "@station/contracts";
import type { EditableTextInputState } from "../components/EditableTextInput/editing.js";
import type { AddProjectFlowState } from "../flows/addProject/types.js";
import type { NewSessionFlowState } from "../flows/newSession.js";
import type { TuiToast } from "../services/types.js";
import type { TuiLocalRows } from "./localRows.js";
import type { TuiSelectionState } from "./selection/types.js";

export type TuiRuntimeState = {
  persistentPopup: boolean;
  canDismissPopup: boolean;
  exitOnFocusSuccess: boolean;
  canResolveFocusOrigin: boolean;
  hasFocusSuccessCallback: boolean;
  focusOrigin?: TerminalFocusOrigin;
};

export type TuiViewState = {
  searchQuery: string;
  collapsedProjectIds: ReadonlySet<string>;
  scrollOffset: number;
  terminalRows: number;
  localRows: TuiLocalRows;
  /** List cursor; native overlays synchronize it once per open and clear it on close. */
  focusedRowId?: WorktreeId;
  /** Per-list cursor for screens migrated onto the shared selection engine. */
  selection: TuiSelectionState;
};

export type TuiState = TuiViewState & {
  snapshot?: StationSnapshot;
  loading: boolean;
  screen: TuiScreen;
  toasts: TuiToastEntry[];
  observerConnectionStatus: TuiObserverConnectionStatus;
  runtime: TuiRuntimeState;
  /**
   * Live top-row widget set, seeded from `[tui].widgets`. Widget-settings
   * edits land here first and are written back to config.toml when a config
   * path exists.
   */
  widgets: readonly TuiWidgetConfig[];
  /** False when no config.toml path exists to write widget edits back to. */
  widgetsPersisted: boolean;
};

export type TuiToastEntry = {
  id: string;
  toast: TuiToast;
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
  | { name: "search"; value: string }
  | { name: "projectCollapse" }
  | { name: "projectSettingsPicker" }
  | { name: "removeWorktree"; step: "chooseSlot" }
  | { name: "removeWorktree"; step: "unavailable" }
  | {
      name: "removeWorktree";
      step: "confirm";
      rowId: WorktreeId;
      forceRequired: boolean;
      label: string;
    }
  | { name: "renameSession"; step: "chooseSlot" }
  | {
      name: "renameSession";
      step: "editName";
      rowId: WorktreeId;
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
      draftBranch: EditableTextInputState;
      nameSource: "generated" | "edited";
      copyDirty: boolean;
      focus: "branch" | "copyDirty" | "submit";
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
  searchQuery?: string;
  collapsedProjectIds?: Iterable<string>;
  scrollOffset?: number;
  terminalRows?: number;
  localRows?: TuiLocalRows;
  focusedRowId?: WorktreeId;
  widgets?: readonly TuiWidgetConfig[];
  widgetsPersisted?: boolean;
  runtime?: Partial<TuiRuntimeState>;
};
