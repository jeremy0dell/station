import { randomUUID } from "node:crypto";
import type {
  ProjectId,
  ProviderId,
  SafeError,
  SessionGroupId,
  SessionGroupPlacementIntent,
  StationSnapshot,
} from "@station/contracts";
import { stableName, stableNameHash } from "@station/runtime";
import {
  createEditableTextInputState,
  type EditableTextEditAction,
  type EditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../components/EditableTextInput/editing.js";
import {
  selectNewSessionHarnessOptions,
  selectNewSessionProject,
  selectNewSessionRootGroup,
} from "../selectors/selectors.js";
import type { ReadonlyDeep } from "../state/readonly.js";
import {
  backWizardStep,
  createStepWizardState,
  enterWizardStep,
  resetWizardStep,
  type StepWizardState,
} from "./stepWizard.js";

export type NewSessionTitleSource = "generated" | "custom";
export type NewSessionStep =
  | "review"
  | "editName"
  | "pickProject"
  | "pickAgent"
  | "pickGroup"
  | "editGroupDraft";
export type NewSessionGroupSelection = { kind: "ungrouped" } | SessionGroupPlacementIntent;

type NewSessionBaseState = StepWizardState<NewSessionStep> & {
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

// Traversal order matches the review's top-to-bottom render.
const REVIEW_FIELDS: readonly NewSessionReviewFocus[] = [
  "project",
  "name",
  "agent",
  "group",
  "create",
];

function cycleReviewFocus(current: NewSessionReviewFocus, dir: -1 | 1): NewSessionReviewFocus {
  return cycleFocus(REVIEW_FIELDS, current, dir);
}

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
type NewSessionSnapshotView = ReadonlyDeep<StationSnapshot>;

export type NewSessionFlowAction =
  | { type: "editName" }
  | { type: "editNameInput"; action: EditableTextEditAction }
  | { type: "commitName" }
  | { type: "pickProject" }
  | { type: "pickAgent" }
  | { type: "pickGroup" }
  | { type: "editGroupDraft" }
  | { type: "editGroupDraftInput"; action: EditableTextEditAction }
  | { type: "commitGroupDraft" }
  | { type: "chooseUngrouped" }
  | { type: "reviewFocus"; dir: -1 | 1 }
  | { type: "editNameFocusSet"; focus: NewSessionEditNameFocus }
  | { type: "cancel" };

export type NewSessionInputKey = {
  ctrl?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

export type NewSessionInput = {
  input: string;
  key: NewSessionInputKey;
  token: string;
};

export type NewSessionInputIntent =
  | {
      type: "transition";
      action: NewSessionFlowAction;
    }
  | {
      type: "submit";
    }
  | {
      type: "none";
    };

type NewSessionActionDefinition =
  | {
      mode: "review" | "editName" | "editGroupDraft";
      intent: "transition";
      action: NewSessionFlowAction;
    }
  | { mode: "review"; intent: "submit" };

const NEW_SESSION_ACTIONS = {
  "review.project": { mode: "review", intent: "transition", action: { type: "pickProject" } },
  "review.name": { mode: "review", intent: "transition", action: { type: "editName" } },
  "review.agent": { mode: "review", intent: "transition", action: { type: "pickAgent" } },
  "review.group": { mode: "review", intent: "transition", action: { type: "pickGroup" } },
  "review.create": { mode: "review", intent: "submit" },
  "editName.name": {
    mode: "editName",
    intent: "transition",
    action: { type: "editNameFocusSet", focus: "name" },
  },
  "editName.save": { mode: "editName", intent: "transition", action: { type: "commitName" } },
  "editName.back": { mode: "editName", intent: "transition", action: { type: "cancel" } },
  "editGroupDraft.save": {
    mode: "editGroupDraft",
    intent: "transition",
    action: { type: "commitGroupDraft" },
  },
  "editGroupDraft.back": {
    mode: "editGroupDraft",
    intent: "transition",
    action: { type: "cancel" },
  },
} as const satisfies Readonly<Record<string, NewSessionActionDefinition>>;

export type NewSessionActionId = keyof typeof NEW_SESSION_ACTIONS;

/** Returns whether a New Session control is visible and currently actionable. */
export function newSessionActionEnabled(
  snapshot: NewSessionSnapshotView | undefined,
  state: NewSessionFlowStateView,
  actionId: NewSessionActionId,
): boolean {
  if (NEW_SESSION_ACTIONS[actionId].mode !== state.mode) return false;
  if (state.mode === "review" && state.submissionLocalId !== undefined) return false;
  if (actionId === "editGroupDraft.save") {
    return state.mode === "editGroupDraft" && state.draftGroupName.value.trim().length > 0;
  }
  return (
    actionId !== "review.create" ||
    (snapshot !== undefined &&
      state.mode === "review" &&
      validateNewSessionCreate(snapshot, state).ok)
  );
}

export type NewSessionCreateValidation =
  | {
      ok: true;
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
      title: string;
      branch: string;
      harnessProvider: ProviderId;
      group?: SessionGroupPlacementIntent;
    }
  | {
      ok: false;
      error: SafeError;
    };

export type NewSessionProjectResolution =
  | {
      kind: "available";
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
    }
  | {
      kind: "blocked";
      error: SafeError;
    }
  | {
      kind: "missing";
    };

export function createNewSessionFlow(
  snapshot: NewSessionSnapshotView,
  token: string,
  options: { projectId?: ProjectId; groupId?: SessionGroupId } = {},
): NewSessionReviewState | undefined {
  const project =
    options.projectId !== undefined
      ? snapshot.projects.find((p) => p.id === options.projectId)
      : snapshot.projects[0];
  if (project === undefined) {
    return undefined;
  }
  const harness = firstHarnessOption(snapshot, project);
  if (harness === undefined) {
    return undefined;
  }
  const branch = generatedSessionBranch(project.id, token);
  return {
    ...createStepWizardState("review"),
    reviewFocus: "create",
    selectedProjectId: project.id,
    selectedHarness: harness.id,
    title: branch,
    branch,
    titleSource: "generated",
    groupSelection:
      options.groupId !== undefined &&
      selectNewSessionRootGroup(snapshot, project.id, options.groupId) !== undefined
        ? { kind: "existing", groupId: options.groupId }
        : { kind: "ungrouped" },
  };
}

export function transitionNewSessionFlow(
  state: NewSessionFlowState,
  action: NewSessionFlowAction,
): NewSessionFlowState | undefined {
  switch (action.type) {
    case "cancel":
      return cancelNewSessionStep(state);
    case "editName":
      return {
        ...enterWizardStep(baseState(state), "editName"),
        draftName: createEditableTextInputState(),
        editNameFocus: "name",
      } satisfies NewSessionEditNameState;
    case "editNameInput":
      return state.mode === "editName"
        ? {
            ...state,
            draftName: transitionEditableTextInput(state.draftName, action.action),
          }
        : state;
    case "commitName":
      return state.mode === "editName" ? commitEditedName(state) : state;
    case "pickProject":
      return {
        ...enterWizardStep(baseState(state), "pickProject"),
      } satisfies NewSessionPickProjectState;
    case "pickAgent":
      return {
        ...enterWizardStep(baseState(state), "pickAgent"),
      } satisfies NewSessionPickAgentState;
    case "pickGroup":
      return {
        ...enterWizardStep(baseState(state), "pickGroup"),
      } satisfies NewSessionPickGroupState;
    case "editGroupDraft":
      return state.mode === "pickGroup"
        ? {
            ...enterWizardStep(baseState(state), "editGroupDraft"),
            draftGroupName: createEditableTextInputState(),
          }
        : state;
    case "editGroupDraftInput":
      return state.mode === "editGroupDraft"
        ? {
            ...state,
            draftGroupName: transitionEditableTextInput(state.draftGroupName, action.action),
          }
        : state;
    case "commitGroupDraft":
      return state.mode === "editGroupDraft" ? commitGroupDraft(state) : state;
    case "chooseUngrouped":
      return state.mode === "pickGroup"
        ? toReviewState({ ...state, groupSelection: { kind: "ungrouped" } }, "group")
        : state;
    case "reviewFocus":
      return state.mode === "review"
        ? { ...state, reviewFocus: cycleReviewFocus(state.reviewFocus, action.dir) }
        : state;
    case "editNameFocusSet":
      return state.mode === "editName" ? { ...state, editNameFocus: action.focus } : state;
  }
}

export function newSessionIntentForInput(
  state: NewSessionFlowStateView,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (state.mode === "review" && state.submissionLocalId !== undefined) {
    return { type: "none" };
  }
  const actionId = newSessionActionForInput(state, input);
  if (actionId !== undefined) {
    return newSessionIntentForAction(state, actionId);
  }
  if (state.mode === "pickGroup") {
    if (input.input === "U") return transitionIntent({ type: "chooseUngrouped" });
    if (input.input === "N") return transitionIntent({ type: "editGroupDraft" });
  }
  if (input.key.escape === true) {
    return transitionIntent({ type: "cancel" });
  }
  switch (state.mode) {
    case "review":
      return reviewInputIntent(input);
    case "editName":
      return editNameInputIntent(state, input);
    case "editGroupDraft":
      return editGroupDraftInputIntent(state, input);
    // Pick steps are registered lists: the shared selectionMiddleware resolves
    // ↑↓/↵/slot before this handler runs, so nothing is left for it to intent.
    case "pickProject":
    case "pickAgent":
    case "pickGroup":
      return { type: "none" };
  }
}

/** Resolves a visible New Session control into a renderer-neutral flow intent. */
export function newSessionIntentForAction(
  state: NewSessionFlowStateView,
  actionId: NewSessionActionId,
): NewSessionInputIntent {
  const definition = NEW_SESSION_ACTIONS[actionId];
  if (definition.mode !== state.mode) return { type: "none" };
  return definition.intent === "submit" ? { type: "submit" } : transitionIntent(definition.action);
}

/** Decodes only semantic control activation; text editing and focus movement stay as input intents. */
export function newSessionActionForInput(
  state: NewSessionFlowStateView,
  input: Pick<NewSessionInput, "input" | "key">,
): NewSessionActionId | undefined {
  if (state.mode === "review") {
    if (isReturn(input)) return `review.${state.reviewFocus}`;
    if (input.input === "P") return "review.project";
    if (input.input === "N") return "review.name";
    if (input.input === "A") return "review.agent";
    if (input.input === "G") return "review.group";
    return input.input === "C" ? "review.create" : undefined;
  }
  if (state.mode === "editGroupDraft") {
    if (input.key.escape === true) return "editGroupDraft.back";
    return isReturn(input) ? "editGroupDraft.save" : undefined;
  }
  if (state.mode !== "editName") return undefined;
  if (input.key.escape === true) return "editName.back";
  if (input.key.ctrl === true && input.input === "s") return "editName.save";
  if (!isReturn(input)) return undefined;
  return state.editNameFocus === "back" ? "editName.back" : "editName.save";
}

export function selectedProject(snapshot: NewSessionSnapshotView, state: NewSessionFlowStateView) {
  return selectNewSessionProject(snapshot, state.selectedProjectId);
}

export function validateNewSessionCreate(
  snapshot: NewSessionSnapshotView,
  state: NewSessionFlowStateView,
): NewSessionCreateValidation {
  const resolution = resolveNewSessionProjectAvailability(selectedProject(snapshot, state));
  if (resolution.kind === "missing") {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "PROJECT_NOT_CONFIGURED",
        message: "No project is configured for a new session.",
        hint: "Add a project to config.toml and run station reconcile.",
      },
    };
  }
  if (resolution.kind === "blocked") {
    return {
      ok: false,
      error: resolution.error,
    };
  }
  const project = resolution.project;

  const harness = selectNewSessionHarnessOptions(snapshot, project).find(
    (option) => option.id === state.selectedHarness,
  );
  if (harness?.status === "unavailable") {
    return {
      ok: false,
      error:
        harness.health?.lastError ??
        ({
          tag: "ProviderUnavailableError",
          code: "HARNESS_PROVIDER_UNAVAILABLE",
          message: `The harness provider ${harness.id} is unavailable.`,
          hint: "Run station doctor for provider diagnostics.",
          provider: harness.id,
        } satisfies SafeError),
    };
  }

  const title = state.title.trim();
  if (title.length === 0) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_TITLE_EMPTY",
        message: "Session name cannot be empty.",
      },
    };
  }

  const group = resolveGroupPlacement(snapshot, state);
  if (!group.ok) return group;

  return {
    ok: true,
    project,
    title,
    branch: state.branch,
    harnessProvider: state.selectedHarness,
    ...(group.placement === undefined ? {} : { group: group.placement }),
  };
}

export function resolveNewSessionProjectAvailability(
  project: ReturnType<typeof selectNewSessionProject>,
): NewSessionProjectResolution {
  if (project === undefined) {
    return { kind: "missing" };
  }
  if (project.health.status === "unavailable") {
    return {
      kind: "blocked",
      error:
        project.health.lastError ??
        ({
          tag: "ProviderUnavailableError",
          code: "WORKTREE_PROVIDER_UNAVAILABLE",
          message: "The worktree provider is unavailable.",
          hint: "Run station doctor for provider diagnostics.",
          provider: project.health.providerId,
        } satisfies SafeError),
    };
  }
  return { kind: "available", project };
}

export function generatedSessionBranch(projectId: ProjectId, token: string): string {
  return stableName({
    profile: "path-segment",
    display: [projectId, token],
    unique: [projectId, token],
  });
}

export function createNewSessionNameToken(unique: string = randomUUID()): string {
  return stableNameHash(["new-session", unique], 6);
}

function reviewInputIntent(input: NewSessionInput): NewSessionInputIntent {
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "reviewFocus", dir: -1 });
  }
  return input.key.downArrow === true
    ? transitionIntent({ type: "reviewFocus", dir: 1 })
    : { type: "none" };
}

function editNameInputIntent(
  state: NewSessionEditNameStateView,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (state.editNameFocus === "name") {
    if (input.key.downArrow === true) {
      return transitionIntent({ type: "editNameFocusSet", focus: "save" });
    }
    const intent = editableTextInputIntentForInput(input);
    return intent.type === "edit"
      ? transitionIntent({ type: "editNameInput", action: intent.action })
      : { type: "none" };
  }
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "editNameFocusSet", focus: "name" });
  }
  if (input.key.leftArrow === true || input.key.rightArrow === true) {
    return transitionIntent({
      type: "editNameFocusSet",
      focus: state.editNameFocus === "save" ? "back" : "save",
    });
  }
  return { type: "none" };
}

function editGroupDraftInputIntent(
  _state: ReadonlyDeep<NewSessionEditGroupDraftState>,
  input: NewSessionInput,
): NewSessionInputIntent {
  const intent = editableTextInputIntentForInput(input);
  return intent.type === "edit"
    ? transitionIntent({ type: "editGroupDraftInput", action: intent.action })
    : { type: "none" };
}

function cycleFocus<T extends string>(values: readonly T[], current: T, dir: -1 | 1): T {
  const index = values.indexOf(current);
  const next = (index + dir + values.length) % values.length;
  return values[next] ?? current;
}

function transitionIntent(action: NewSessionFlowAction): NewSessionInputIntent {
  return {
    type: "transition",
    action,
  };
}

function isReturn(input: Pick<NewSessionInput, "input" | "key">): boolean {
  return input.key.return === true || input.input === "\r" || input.input === "\n";
}

function commitEditedName(state: NewSessionEditNameState): NewSessionReviewState {
  const title = state.draftName.value.trim();
  if (title.length === 0) {
    return toReviewState(state);
  }
  return {
    ...toReviewState(state),
    title,
    titleSource: "custom",
  };
}

function commitGroupDraft(
  state: NewSessionEditGroupDraftState,
): NewSessionEditGroupDraftState | NewSessionReviewState {
  const name = state.draftGroupName.value.trim();
  return name.length === 0
    ? state
    : toReviewState({ ...state, groupSelection: { kind: "create", name } }, "group");
}

/** Commit a project chosen by id (the shared selection engine's cursor/slot value). */
export function chooseNewSessionProjectById(
  state: NewSessionPickProjectState,
  snapshot: NewSessionSnapshotView,
  projectId: ProjectId,
  token: string,
): NewSessionPickProjectState | NewSessionReviewState {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  return project === undefined ? state : applyChosenProject(state, snapshot, project, token);
}

function applyChosenProject(
  state: NewSessionPickProjectState,
  snapshot: NewSessionSnapshotView,
  project: NonNullable<ReturnType<typeof selectNewSessionProject>>,
  token: string,
): NewSessionPickProjectState | NewSessionReviewState {
  // Harness options are global, so a chosen harness stays valid across projects;
  // keep the user's selection and only fall back to the default if it disappears.
  const options = selectNewSessionHarnessOptions(snapshot, project);
  const harness = options.find((option) => option.id === state.selectedHarness) ?? options[0];
  if (harness === undefined) {
    return state;
  }
  const branch = generatedSessionBranch(project.id, token);
  const sameProject = project.id === state.selectedProjectId;
  return {
    ...toReviewState(state),
    selectedProjectId: project.id,
    selectedHarness: harness.id,
    branch: sameProject ? state.branch : branch,
    title: state.titleSource === "generated" ? (sameProject ? state.title : branch) : state.title,
    groupSelection: sameProject
      ? reconcileGroupSelection(snapshot, project.id, state.groupSelection)
      : { kind: "ungrouped" },
  };
}

function firstHarnessOption(
  snapshot: NewSessionSnapshotView,
  project: NonNullable<ReturnType<typeof selectNewSessionProject>>,
) {
  return selectNewSessionHarnessOptions(snapshot, project)[0];
}

/** Commit an agent chosen by id (the shared selection engine's cursor/slot value). */
export function chooseNewSessionAgentById(
  state: NewSessionPickAgentState,
  snapshot: NewSessionSnapshotView,
  agentId: ProviderId,
): NewSessionPickAgentState | NewSessionReviewState {
  const project = selectedProject(snapshot, state);
  const option =
    project === undefined
      ? undefined
      : selectNewSessionHarnessOptions(snapshot, project).find((entry) => entry.id === agentId);
  if (option === undefined) {
    return state;
  }
  return {
    ...toReviewState(state),
    selectedHarness: option.id,
  };
}

export function chooseNewSessionGroupById(
  state: NewSessionPickGroupState,
  snapshot: NewSessionSnapshotView,
  groupId: SessionGroupId,
): NewSessionPickGroupState | NewSessionReviewState {
  return selectNewSessionRootGroup(snapshot, state.selectedProjectId, groupId) === undefined
    ? state
    : toReviewState({ ...state, groupSelection: { kind: "existing", groupId } }, "group");
}

export function chooseNewSessionUngrouped(state: NewSessionPickGroupState): NewSessionReviewState {
  return toReviewState({ ...state, groupSelection: { kind: "ungrouped" } }, "group");
}

export function reconcileNewSessionFlow(
  state: NewSessionFlowState,
  snapshot: NewSessionSnapshotView,
): NewSessionFlowState {
  const groupSelection = reconcileGroupSelection(
    snapshot,
    state.selectedProjectId,
    state.groupSelection,
  );
  return sameGroupSelection(groupSelection, state.groupSelection)
    ? state
    : { ...state, groupSelection };
}

function cancelNewSessionStep(
  state: NewSessionFlowState,
): NewSessionReviewState | NewSessionPickGroupState | undefined {
  if (state.mode === "editGroupDraft") {
    return {
      ...baseState(state),
      mode: "pickGroup",
      stepHistory: state.stepHistory.slice(0, -1),
    } satisfies NewSessionPickGroupState;
  }
  const previous = backWizardStep(baseState(state));
  if (previous === undefined) {
    return undefined;
  }
  return toReviewState(previous, state.mode === "pickGroup" ? "group" : "create");
}

// Every return-to-review path funnels here so the focus-reset policy has one owner.
function toReviewState(
  state: NewSessionBaseState,
  reviewFocus: NewSessionReviewFocus = "create",
): NewSessionReviewState {
  return {
    ...resetWizardStep(baseState(state), "review"),
    reviewFocus,
  };
}

function baseState(state: NewSessionBaseState): NewSessionBaseState {
  return {
    mode: state.mode,
    stepHistory: state.stepHistory,
    selectedProjectId: state.selectedProjectId,
    selectedHarness: state.selectedHarness,
    title: state.title,
    branch: state.branch,
    titleSource: state.titleSource,
    groupSelection: state.groupSelection,
  };
}

function resolveGroupPlacement(
  snapshot: NewSessionSnapshotView,
  state: NewSessionFlowStateView,
): { ok: true; placement?: SessionGroupPlacementIntent } | { ok: false; error: SafeError } {
  if (state.groupSelection.kind === "ungrouped") return { ok: true };
  if (state.groupSelection.kind === "create") {
    const name = state.groupSelection.name.trim();
    return name.length === 0
      ? {
          ok: false,
          error: {
            tag: "CommandValidationError",
            code: "SESSION_GROUP_NAME_EMPTY",
            message: "Group name cannot be empty.",
          },
        }
      : { ok: true, placement: { kind: "create", name } };
  }
  const selection = state.groupSelection;
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === selection.groupId);
  if (group === undefined) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_NOT_FOUND",
        message: "The selected Group no longer exists.",
      },
    };
  }
  if (group.projectId !== state.selectedProjectId) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_PROJECT_MISMATCH",
        message: "The selected Group belongs to another project.",
      },
    };
  }
  if (group.parentGroupId !== undefined) {
    return {
      ok: false,
      error: {
        tag: "CommandValidationError",
        code: "SESSION_GROUP_NOT_ROOT",
        message: "Nested Groups cannot receive a new session.",
      },
    };
  }
  return { ok: true, placement: selection };
}

function reconcileGroupSelection(
  snapshot: NewSessionSnapshotView,
  projectId: ProjectId,
  selection: NewSessionGroupSelection,
): NewSessionGroupSelection {
  if (selection.kind !== "existing") return selection;
  return selectNewSessionRootGroup(snapshot, projectId, selection.groupId) === undefined
    ? { kind: "ungrouped" }
    : selection;
}

function sameGroupSelection(
  left: NewSessionGroupSelection,
  right: NewSessionGroupSelection,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ungrouped") return true;
  if (left.kind === "existing" && right.kind === "existing") {
    return left.groupId === right.groupId;
  }
  return left.kind === "create" && right.kind === "create" && left.name === right.name;
}
