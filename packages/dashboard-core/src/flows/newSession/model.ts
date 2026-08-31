import type {
  ProjectId,
  ProviderId,
  SessionGroupPlacementIntent,
  StationSnapshot,
} from "@station/contracts";
import type { EditableTextInputState } from "../../components/EditableTextInput/editing.js";
import type { ReadonlyDeep } from "../../state/readonly.js";
import type { StepWizardState } from "../stepWizard.js";

export type NewSessionTitleSource = "generated" | "custom";
export type NewSessionStep =
  | "review"
  | "editName"
  | "pickProject"
  | "pickAgent"
  | "pickGroup"
  | "editGroupDraft";
export type NewSessionGroupSelection = { kind: "ungrouped" } | SessionGroupPlacementIntent;

export type NewSessionBaseState = StepWizardState<NewSessionStep> & {
  selectedProjectId: ProjectId;
  selectedHarness: ProviderId;
  title: string;
  branch: string;
  titleSource: NewSessionTitleSource;
  groupSelection: NewSessionGroupSelection;
};

/** The review menu's focus ring — which field ↵ acts on. */
export type NewSessionReviewFocus = "name" | "project" | "agent" | "group" | "create";
export type NewSessionEditNameFocus = "name" | "save" | "back";

export type NewSessionReviewState = NewSessionBaseState & {
  mode: "review";
  /** Default "create" so ↵ still creates, preserving today's muscle memory. */
  reviewFocus: NewSessionReviewFocus;
  submissionLocalId?: string;
};

export type NewSessionEditNameState = NewSessionBaseState & {
  mode: "editName";
  draftName: EditableTextInputState;
  editNameFocus: NewSessionEditNameFocus;
};

export type NewSessionPickProjectState = NewSessionBaseState & {
  mode: "pickProject";
};

export type NewSessionPickAgentState = NewSessionBaseState & {
  mode: "pickAgent";
};

export type NewSessionPickGroupState = NewSessionBaseState & {
  mode: "pickGroup";
};

export type NewSessionEditGroupDraftState = NewSessionBaseState & {
  mode: "editGroupDraft";
  draftGroupName: EditableTextInputState;
};

export type NewSessionFlowState =
  | NewSessionReviewState
  | NewSessionEditNameState
  | NewSessionPickProjectState
  | NewSessionPickAgentState
  | NewSessionPickGroupState
  | NewSessionEditGroupDraftState;

/** Deep-readonly New Session flow consumed by presentation and intent readers. */
export type NewSessionFlowStateView = ReadonlyDeep<NewSessionFlowState>;
export type NewSessionReviewStateView = ReadonlyDeep<NewSessionReviewState>;
export type NewSessionEditNameStateView = ReadonlyDeep<NewSessionEditNameState>;
export type NewSessionEditGroupDraftStateView = ReadonlyDeep<NewSessionEditGroupDraftState>;
export type NewSessionSnapshotView = ReadonlyDeep<StationSnapshot>;
