import { createStepWizardState, enterWizardStep } from "../stepWizard.js";
import { normalizeProjectId } from "./input.js";
import type {
  AddProjectChooseState,
  AddProjectFailedState,
  AddProjectFlowAction,
  AddProjectFlowState,
  AddProjectReviewState,
  AddProjectStartChoice,
  AddProjectStartState,
  AddProjectStep,
  AddProjectSuccessState,
  CreateAddProjectFlowInput,
} from "./types.js";

type AddProjectWizardFields<TMode extends AddProjectStep> = {
  mode: TMode;
  stepHistory: AddProjectFlowState["stepHistory"];
  firstProject: boolean;
};

export function createAddProjectStartState(input: CreateAddProjectFlowInput): AddProjectStartState {
  const wizard = createStepWizardState("start");
  return {
    mode: wizard.mode,
    stepHistory: wizard.stepHistory,
    firstProject: input.firstProject === true,
    choices: startChoices(input.cwd, input.homeDir),
  };
}

export function chooseStateForLoadedFolder(
  state: AddProjectFlowState,
  currentPath: string,
  entries: AddProjectChooseState["entries"],
  options: { error?: AddProjectChooseState["error"] } = {},
): AddProjectChooseState {
  const nextState: AddProjectChooseState = {
    ...wizardFieldsFor(state, "choose"),
    currentPath,
    entries,
    filter: "",
    filterMode: false,
    loading: false,
    searchEntries: [],
    searching: false,
    searchTruncated: false,
  };
  if (options.error !== undefined) {
    nextState.error = options.error;
  }
  return nextState;
}

export function reviewStateForFolder(
  state: AddProjectFlowState,
  review: Extract<AddProjectFlowAction, { type: "folderReviewed" }>["review"],
): AddProjectReviewState {
  const nextState: AddProjectReviewState = {
    ...wizardFieldsFor(state, "review"),
    selectedPath: review.selectedPath,
    id: review.id,
    label: review.label,
    submitting: false,
    actionFocus: review.gitRoot === undefined ? "chooseFolder" : "submit",
  };
  if (review.gitRoot !== undefined) {
    nextState.gitRoot = review.gitRoot;
  }
  return nextState;
}

export function failedStateForError(
  state: AddProjectFlowState,
  selectedPath: string,
  error: AddProjectFailedState["error"],
): AddProjectFailedState {
  return {
    ...wizardFieldsFor(state, "failed"),
    selectedPath,
    error,
    actionFocus: "retry",
  };
}

export function successStateForProject(
  state: AddProjectFlowState,
  label: string,
  root: string,
): AddProjectSuccessState {
  return {
    ...wizardFieldsFor(state, "success"),
    label,
    root,
    actionFocus: "dashboard",
  };
}

export function commitEditedProjectId(state: AddProjectReviewState): AddProjectReviewState {
  const editedId = normalizeProjectId(state.editingId?.value ?? state.id);
  return {
    ...reviewWithoutEditingId(state),
    id: editedId,
  };
}

export function reviewWithoutEditingId(state: AddProjectReviewState): AddProjectReviewState {
  const { editingId: _editingId, editIdActionFocus: _editIdActionFocus, ...review } = state;
  return {
    ...review,
    actionFocus: review.gitRoot === undefined ? "chooseFolder" : "submit",
  };
}

export function withoutSearchError(state: AddProjectChooseState): AddProjectChooseState {
  const { searchError: _searchError, ...nextState } = state;
  return nextState;
}

function wizardFieldsFor<TMode extends AddProjectStep>(
  state: AddProjectFlowState,
  mode: TMode,
): AddProjectWizardFields<TMode> {
  if (state.mode === mode) {
    return {
      mode,
      stepHistory: state.stepHistory,
      firstProject: state.firstProject,
    };
  }
  const next = enterWizardStep(state, mode);
  return {
    mode: next.mode,
    stepHistory: next.stepHistory,
    firstProject: state.firstProject,
  };
}

function startChoices(cwd: string, homeDir: string): AddProjectStartChoice[] {
  return [
    {
      id: "addProjectStart:currentDirectory",
      label: "current directory",
      path: cwd,
      detail: cwd,
    },
    {
      id: "addProjectStart:homeDirectory",
      label: "~",
      path: homeDir,
      detail: "home",
    },
  ];
}
