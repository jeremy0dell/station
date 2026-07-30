import { randomUUID } from "node:crypto";
import type { ProjectId, ProviderId, SafeError, StationSnapshot } from "@station/contracts";
import { stableName, stableNameHash } from "@station/runtime";
import {
  createEditableTextInputState,
  type EditableTextEditAction,
  type EditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../components/EditableTextInput/editing.js";
import { selectNewSessionHarnessOptions, selectNewSessionProject } from "../selectors/selectors.js";
import {
  backWizardStep,
  createStepWizardState,
  enterWizardStep,
  resetWizardStep,
  type StepWizardState,
} from "./stepWizard.js";

export type NewSessionTitleSource = "generated" | "custom";
export type NewSessionStep = "review" | "editName" | "pickProject" | "pickAgent";

type NewSessionBaseState = StepWizardState<NewSessionStep> & {
  selectedProjectId: ProjectId;
  selectedHarness: ProviderId;
  title: string;
  branch: string;
  titleSource: NewSessionTitleSource;
};

/** The review menu's focus ring — which field ↵ acts on. */
export type NewSessionReviewFocus = "name" | "project" | "agent" | "create";
export type NewSessionEditNameFocus = "name" | "save" | "back";

// Traversal order matches the review's top-to-bottom render (Project, Name,
// Agent, then the Create action).
const REVIEW_FIELDS: readonly NewSessionReviewFocus[] = ["project", "name", "agent", "create"];

function cycleReviewFocus(current: NewSessionReviewFocus, dir: -1 | 1): NewSessionReviewFocus {
  return cycleFocus(REVIEW_FIELDS, current, dir);
}

const EDIT_NAME_CONTROLS: readonly NewSessionEditNameFocus[] = ["name", "save", "back"];

export type NewSessionReviewState = NewSessionBaseState & {
  mode: "review";
  /** Default "create" so ↵ still creates, preserving today's muscle memory. */
  reviewFocus: NewSessionReviewFocus;
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

export type NewSessionFlowState =
  | NewSessionReviewState
  | NewSessionEditNameState
  | NewSessionPickProjectState
  | NewSessionPickAgentState;

export type NewSessionFlowAction =
  | { type: "editName" }
  | { type: "editNameInput"; action: EditableTextEditAction }
  | { type: "commitName" }
  | { type: "pickProject" }
  | { type: "pickAgent" }
  | { type: "reviewFocus"; dir: -1 | 1 }
  | { type: "editNameFocus"; dir: -1 | 1 }
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

export type NewSessionActionId =
  | "review.project"
  | "review.name"
  | "review.agent"
  | "review.create"
  | "editName.name"
  | "editName.save"
  | "editName.back";

export type NewSessionActionInput = Pick<NewSessionInput, "input" | "key">;

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

export type NewSessionCreateValidation =
  | {
      ok: true;
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
      title: string;
      branch: string;
      harnessProvider: ProviderId;
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
  snapshot: StationSnapshot,
  token: string,
  projectId?: ProjectId,
): NewSessionReviewState | undefined {
  const project =
    projectId !== undefined
      ? snapshot.projects.find((p) => p.id === projectId)
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
    case "reviewFocus":
      return state.mode === "review"
        ? { ...state, reviewFocus: cycleReviewFocus(state.reviewFocus, action.dir) }
        : state;
    case "editNameFocus":
      return state.mode === "editName"
        ? {
            ...state,
            editNameFocus: cycleFocus(EDIT_NAME_CONTROLS, state.editNameFocus, action.dir),
          }
        : state;
  }
}

export function newSessionIntentForInput(
  state: NewSessionFlowState,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (input.key.escape === true) {
    return transitionIntent({ type: "cancel" });
  }
  switch (state.mode) {
    case "review":
      return reviewInputIntent(state, input);
    case "editName":
      return editNameInputIntent(state, input);
    // Pick steps are registered lists: the shared selectionMiddleware resolves
    // ↑↓/↵/slot before this handler runs, so nothing is left for it to intent.
    case "pickProject":
    case "pickAgent":
      return { type: "none" };
  }
}

/** Maps pointer controls to the same key path owned by the flow's keyboard reducer. */
export function newSessionActionInputPath(
  state: NewSessionFlowState,
  actionId: NewSessionActionId,
): readonly NewSessionActionInput[] | undefined {
  if (state.mode === "review") {
    switch (actionId) {
      case "review.project":
        return [{ input: "P", key: {} }];
      case "review.name":
        return [{ input: "N", key: {} }];
      case "review.agent":
        return [{ input: "A", key: {} }];
      case "review.create":
        return [{ input: "C", key: {} }];
      case "editName.name":
      case "editName.save":
      case "editName.back":
        return undefined;
    }
  }
  if (state.mode !== "editName") return undefined;
  switch (actionId) {
    case "editName.name":
      return editNameFocusInputPath(state.editNameFocus, "name");
    case "editName.save":
      return [{ input: "s", key: { ctrl: true } }];
    case "editName.back":
      return [{ input: "", key: { escape: true } }];
    case "review.project":
    case "review.name":
    case "review.agent":
    case "review.create":
      return undefined;
  }
}

export function selectedProject(snapshot: StationSnapshot, state: NewSessionFlowState) {
  return selectNewSessionProject(snapshot, state.selectedProjectId);
}

export function harnessOptions(...args: Parameters<typeof selectNewSessionHarnessOptions>) {
  return selectNewSessionHarnessOptions(...args);
}

export function validateNewSessionCreate(
  snapshot: StationSnapshot,
  state: NewSessionFlowState,
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

  return {
    ok: true,
    project,
    title,
    branch: state.branch,
    harnessProvider: state.selectedHarness,
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

function reviewInputIntent(
  state: NewSessionReviewState,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "reviewFocus", dir: -1 });
  }
  if (input.key.downArrow === true) {
    return transitionIntent({ type: "reviewFocus", dir: 1 });
  }
  if (isReturn(input)) {
    return reviewFocusIntents[state.reviewFocus];
  }
  return reviewKeyIntents[input.input] ?? { type: "none" };
}

// ↵ activates the focused field; "create" submits, the rest open their step.
const reviewFocusIntents: Record<NewSessionReviewFocus, NewSessionInputIntent> = {
  create: { type: "submit" },
  name: transitionIntent({ type: "editName" }),
  project: transitionIntent({ type: "pickProject" }),
  agent: transitionIntent({ type: "pickAgent" }),
};

const reviewKeyIntents: Record<string, NewSessionInputIntent> = {
  N: transitionIntent({ type: "editName" }),
  P: transitionIntent({ type: "pickProject" }),
  A: transitionIntent({ type: "pickAgent" }),
  C: { type: "submit" },
};

function editNameInputIntent(
  state: NewSessionEditNameState,
  input: NewSessionInput,
): NewSessionInputIntent {
  if (input.key.upArrow === true) {
    return transitionIntent({ type: "editNameFocus", dir: -1 });
  }
  if (input.key.downArrow === true) {
    return transitionIntent({ type: "editNameFocus", dir: 1 });
  }
  if (input.key.ctrl === true && input.input === "s") {
    return transitionIntent({ type: "commitName" });
  }
  if (isReturn(input)) {
    return state.editNameFocus === "back"
      ? transitionIntent({ type: "cancel" })
      : transitionIntent({ type: "commitName" });
  }
  if (state.editNameFocus !== "name") {
    return { type: "none" };
  }
  const intent = editableTextInputIntentForInput(input);
  return intent.type === "edit"
    ? transitionIntent({ type: "editNameInput", action: intent.action })
    : { type: "none" };
}

function editNameFocusInputPath(
  current: NewSessionEditNameFocus,
  target: NewSessionEditNameFocus,
): readonly NewSessionActionInput[] {
  if (current === target) return [];
  const currentIndex = EDIT_NAME_CONTROLS.indexOf(current);
  const targetIndex = EDIT_NAME_CONTROLS.indexOf(target);
  const downSteps =
    (targetIndex - currentIndex + EDIT_NAME_CONTROLS.length) % EDIT_NAME_CONTROLS.length;
  const upSteps =
    (currentIndex - targetIndex + EDIT_NAME_CONTROLS.length) % EDIT_NAME_CONTROLS.length;
  const key: NewSessionInputKey = downSteps <= upSteps ? { downArrow: true } : { upArrow: true };
  return Array.from({ length: Math.min(downSteps, upSteps) }, () => ({ input: "", key }));
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

function isReturn(input: NewSessionInput): boolean {
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

/** Commit a project chosen by id (the shared selection engine's cursor/slot value). */
export function chooseNewSessionProjectById(
  state: NewSessionPickProjectState,
  snapshot: StationSnapshot,
  projectId: ProjectId,
  token: string,
): NewSessionPickProjectState | NewSessionReviewState {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  return project === undefined ? state : applyChosenProject(state, snapshot, project, token);
}

function applyChosenProject(
  state: NewSessionPickProjectState,
  snapshot: StationSnapshot,
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
  return {
    ...toReviewState(state),
    selectedProjectId: project.id,
    selectedHarness: harness.id,
    branch,
    title: state.titleSource === "generated" ? branch : state.title,
  };
}

function firstHarnessOption(
  snapshot: StationSnapshot,
  project: NonNullable<ReturnType<typeof selectNewSessionProject>>,
) {
  return selectNewSessionHarnessOptions(snapshot, project)[0];
}

/** Commit an agent chosen by id (the shared selection engine's cursor/slot value). */
export function chooseNewSessionAgentById(
  state: NewSessionPickAgentState,
  snapshot: StationSnapshot,
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

function cancelNewSessionStep(state: NewSessionFlowState): NewSessionReviewState | undefined {
  const previous = backWizardStep(baseState(state));
  if (previous === undefined) {
    return undefined;
  }
  return toReviewState(previous);
}

// Every return-to-review path funnels here so the focus-reset policy has one owner.
function toReviewState(state: NewSessionBaseState): NewSessionReviewState {
  return {
    ...resetWizardStep(baseState(state), "review"),
    reviewFocus: "create",
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
  };
}
