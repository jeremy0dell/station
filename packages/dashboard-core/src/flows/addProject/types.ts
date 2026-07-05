import type { SafeError, StationCommand } from "@station/contracts";
import type {
  EditableTextEditAction,
  EditableTextInputState,
} from "../../components/EditableTextInput/editing.js";
import type {
  TuiFolderEntry,
  TuiFolderReadResult,
  TuiFolderReview,
  TuiFolderSearchResult,
} from "../../services/folderService.js";
import type { StepWizardState } from "../stepWizard.js";

export type AddProjectStep = "start" | "choose" | "review" | "success" | "failed";

type AddProjectBaseState = StepWizardState<AddProjectStep>;

export type AddProjectStartChoice = {
  label: string;
  path: string;
  detail: string;
};

export type AddProjectStartState = AddProjectBaseState & {
  mode: "start";
  choices: AddProjectStartChoice[];
  selectedIndex: number;
};

export type AddProjectChooseState = AddProjectBaseState & {
  mode: "choose";
  currentPath: string;
  entries: TuiFolderEntry[];
  selectedIndex: number;
  filter: string;
  filterMode: boolean;
  loading: boolean;
  searchEntries: TuiFolderEntry[];
  searching: boolean;
  searchTruncated: boolean;
  searchError?: SafeError;
  error?: SafeError;
};

export type AddProjectReviewState = AddProjectBaseState & {
  mode: "review";
  selectedPath: string;
  gitRoot?: string;
  id: string;
  label: string;
  submitting: boolean;
  editingId?: EditableTextInputState;
};

export type AddProjectSuccessState = AddProjectBaseState & {
  mode: "success";
  label: string;
  root: string;
};

export type AddProjectFailedState = AddProjectBaseState & {
  mode: "failed";
  selectedPath: string;
  error: SafeError;
};

export type AddProjectFlowState =
  | AddProjectStartState
  | AddProjectChooseState
  | AddProjectReviewState
  | AddProjectSuccessState
  | AddProjectFailedState;

export type CreateAddProjectFlowInput = {
  cwd: string;
  homeDir: string;
};

export type AddProjectFlowAction =
  | { type: "move"; delta: number }
  | { type: "select"; index: number }
  | { type: "startOpen" }
  | { type: "chooseOpen" }
  | { type: "chooseParent" }
  | { type: "chooseSelected" }
  | { type: "folderLoaded"; result: TuiFolderReadResult }
  | { type: "folderLoadFailed"; path: string; error: SafeError }
  | { type: "folderSearchLoaded"; result: TuiFolderSearchResult }
  | { type: "folderSearchFailed"; query: string; error: SafeError }
  | { type: "folderReviewed"; review: TuiFolderReview }
  | { type: "folderReviewFailed"; path: string; error: SafeError }
  | { type: "filterStart" }
  | { type: "filterInput"; value: string }
  | { type: "filterBackspace" }
  | { type: "filterClear" }
  | { type: "submit" }
  | { type: "submitted"; label: string; root: string }
  | { type: "submitFailed"; error: SafeError }
  | { type: "editIdStart" }
  | { type: "editIdInput"; action: EditableTextEditAction }
  | { type: "editIdCommit" }
  | { type: "editIdCancel" }
  | { type: "backToChoose" };

export type AddProjectFlowEffect =
  | { type: "loadDirectory"; path: string }
  | { type: "searchDirectories"; query: string }
  | { type: "reviewFolder"; path: string }
  | { type: "submitProject"; command: Extract<StationCommand, { type: "project.add" }> };

export type AddProjectTransition = {
  state?: AddProjectFlowState;
  effects?: AddProjectFlowEffect[];
  cancel?: true;
};
