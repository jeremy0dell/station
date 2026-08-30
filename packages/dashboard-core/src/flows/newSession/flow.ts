import type { ProjectId, ProviderId, SessionGroupId } from "@station/contracts";
import {
  createEditableTextInputState,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import {
  selectNewSessionHarnessOptions,
  selectNewSessionProject,
  selectNewSessionRootGroup,
} from "../../selectors/selectors.js";
import {
  backWizardStep,
  createStepWizardState,
  enterWizardStep,
  resetWizardStep,
} from "../stepWizard.js";
import type { NewSessionFlowAction } from "./actions.js";
import type {
  NewSessionBaseState,
  NewSessionEditGroupDraftState,
  NewSessionEditNameState,
  NewSessionFlowState,
  NewSessionPickAgentState,
  NewSessionPickGroupState,
  NewSessionPickProjectState,
  NewSessionReviewFocus,
  NewSessionReviewState,
  NewSessionSnapshotView,
} from "./model.js";
import { generatedSessionBranch } from "./names.js";
import { reconcileNewSessionGroupSelection } from "./reconciliation.js";

export function createNewSessionFlow(
  snapshot: NewSessionSnapshotView,
  token: string,
  options: { projectId?: ProjectId; groupId?: SessionGroupId } = {},
): NewSessionReviewState | undefined {
  const project =
    options.projectId !== undefined
      ? snapshot.projects.find((candidate) => candidate.id === options.projectId)
      : snapshot.projects[0];
  if (project === undefined) {
    return undefined;
  }
  const harness = selectNewSessionHarnessOptions(snapshot, project)[0];
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

/** Commit an agent chosen by id (the shared selection engine's cursor/slot value). */
export function chooseNewSessionAgentById(
  state: NewSessionPickAgentState,
  snapshot: NewSessionSnapshotView,
  agentId: ProviderId,
): NewSessionPickAgentState | NewSessionReviewState {
  const project = selectNewSessionProject(snapshot, state.selectedProjectId);
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
      ? reconcileNewSessionGroupSelection(snapshot, project.id, state.groupSelection)
      : { kind: "ungrouped" },
  };
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

function cycleReviewFocus(current: NewSessionReviewFocus, dir: -1 | 1): NewSessionReviewFocus {
  const fields: readonly NewSessionReviewFocus[] = ["project", "name", "agent", "group", "create"];
  const index = fields.indexOf(current);
  const next = (index + dir + fields.length) % fields.length;
  return fields[next] ?? current;
}
