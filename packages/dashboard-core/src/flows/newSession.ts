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

export type NewSessionNameSource = "generated" | "custom";
export type NewSessionStep = "review" | "editName" | "pickProject" | "pickAgent";

type NewSessionBaseState = StepWizardState<NewSessionStep> & {
  selectedProjectId: ProjectId;
  selectedHarness: ProviderId;
  branch: string;
  nameSource: NewSessionNameSource;
};

export type NewSessionReviewState = NewSessionBaseState & {
  mode: "review";
};

export type NewSessionEditNameState = NewSessionBaseState & {
  mode: "editName";
  draftName: EditableTextInputState;
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

export type NewSessionCreateValidation =
  | {
      ok: true;
      project: NonNullable<ReturnType<typeof selectNewSessionProject>>;
      branch: string;
      harnessProvider: ProviderId;
    }
  | {
      ok: false;
      error: SafeError;
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
  return {
    ...createStepWizardState("review"),
    selectedProjectId: project.id,
    selectedHarness: harness.id,
    branch: generatedSessionBranch(project.id, token),
    nameSource: "generated",
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
      return reviewInputIntent(input);
    case "editName":
      return editNameInputIntent(input);
    // Pick steps are registered lists: the shared selectionMiddleware resolves
    // ↑↓/↵/slot before this handler runs, so nothing is left for it to intent.
    case "pickProject":
    case "pickAgent":
      return { type: "none" };
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
  const project = selectedProject(snapshot, state);
  if (project === undefined) {
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

  if (project.health.status === "unavailable") {
    return {
      ok: false,
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

  return {
    ok: true,
    project,
    branch: state.branch,
    harnessProvider: state.selectedHarness,
  };
}

export function generatedSessionBranch(projectId: ProjectId, token: string): string {
  return stableName({
    profile: "path-segment",
    display: [projectId, token],
    unique: [projectId, token],
  });
}

export function createNewSessionNameToken(unique = randomUUID()): string {
  return stableNameHash(["new-session", unique], 6);
}

function reviewInputIntent(input: NewSessionInput): NewSessionInputIntent {
  if (isReturn(input)) {
    return { type: "submit" };
  }
  return reviewKeyIntents[input.input] ?? { type: "none" };
}

const reviewKeyIntents: Record<string, NewSessionInputIntent> = {
  N: transitionIntent({ type: "editName" }),
  P: transitionIntent({ type: "pickProject" }),
  A: transitionIntent({ type: "pickAgent" }),
};

function editNameInputIntent(input: NewSessionInput): NewSessionInputIntent {
  if (isReturn(input)) {
    return transitionIntent({ type: "commitName" });
  }
  const intent = editableTextInputIntentForInput(input);
  return intent.type === "edit"
    ? transitionIntent({ type: "editNameInput", action: intent.action })
    : { type: "none" };
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
  const branch = state.draftName.value.trim();
  if (branch.length === 0) {
    return toReviewState(state);
  }
  return {
    ...resetWizardStep(baseState(state), "review"),
    selectedProjectId: state.selectedProjectId,
    selectedHarness: state.selectedHarness,
    branch,
    nameSource: "custom",
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
  return {
    ...resetWizardStep(baseState(state), "review"),
    selectedProjectId: project.id,
    selectedHarness: harness.id,
    branch:
      state.nameSource === "generated" ? generatedSessionBranch(project.id, token) : state.branch,
    nameSource: state.nameSource,
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
    ...resetWizardStep(baseState(state), "review"),
    selectedProjectId: state.selectedProjectId,
    selectedHarness: option.id,
    branch: state.branch,
    nameSource: state.nameSource,
  };
}

function cancelNewSessionStep(state: NewSessionFlowState): NewSessionReviewState | undefined {
  const previous = backWizardStep(baseState(state));
  if (previous === undefined) {
    return undefined;
  }
  return toReviewState(previous);
}

function toReviewState(state: NewSessionBaseState): NewSessionReviewState {
  return {
    ...resetWizardStep(baseState(state), "review"),
  };
}

function baseState(state: NewSessionBaseState): NewSessionBaseState {
  return {
    mode: state.mode,
    stepHistory: state.stepHistory,
    selectedProjectId: state.selectedProjectId,
    selectedHarness: state.selectedHarness,
    branch: state.branch,
    nameSource: state.nameSource,
  };
}
