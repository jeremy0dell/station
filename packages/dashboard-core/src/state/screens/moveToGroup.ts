import type { SessionGroupId, SessionId } from "@station/contracts";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import {
  selectDashboardSessionRow,
  sessionRowDisplayTitle,
} from "../../selectors/dashboardSessionRows.js";
import { selectMoveToGroupSessionContext } from "../../selectors/sessionGroupChoices.js";
import { buildCreateSessionGroupCommand } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { DashboardVisibleRowsSource } from "../layoutVisibility.js";
import { resolveMoveSessionToGroupOperation } from "../operations/sessionGroups.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardScreenView, DashboardState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";

type MoveToGroupScreen = Extract<DashboardState["screen"], { name: "moveToGroup" }>;
type MoveToGroupScreenView = Extract<DashboardScreenView, { name: "moveToGroup" }>;

const chooseSlotBehavior = { dashboardHoverEnabled: true };
const sheetBehavior = { dashboardHoverEnabled: false, clickAway: cancelMoveToGroup };

export const MOVE_TO_GROUP_LIST_ID = "moveToGroupDestination";
export const MOVE_TO_GROUP_UNGROUPED_CHOICE_ID = "moveToGroup:ungrouped";
export const MOVE_TO_GROUP_CREATE_CHOICE_ID = "moveToGroup:create";

export function moveToGroupExistingChoiceId(groupId: SessionGroupId): string {
  return `moveToGroup:existing:${groupId}`;
}

export function moveToGroupScreenBehavior(screen: MoveToGroupScreenView) {
  return screen.step === "chooseSlot" ? chooseSlotBehavior : sheetBehavior;
}

export function handleMoveToGroupKey(
  state: DashboardState,
  key: TuiKey,
  visibleRows?: DashboardVisibleRowsSource,
): TuiTransition {
  if (state.screen.name !== "moveToGroup") return { state };
  if (state.screen.step === "chooseSlot") {
    if (key.escape === true) return { state: cancelMoveToGroup(state) };
    return handleDashboardRowChoiceKey(
      state,
      key,
      (current, rowId) => ({ state: openMoveToGroupForRow(current, rowId) }),
      visibleRows,
    );
  }
  if (state.screen.submitting) return { state };
  if (state.screen.step === "chooseDestination") {
    if (key.escape === true) return { state: cancelMoveToGroup(state) };
    if (key.input === "U") return selectMoveToGroupDestination(state, null);
    if (key.input === "N") return { state: openMoveToGroupCreate(state) };
    return { state };
  }
  if (key.escape === true) return { state: backToMoveToGroupDestinations(state) };
  if (isReturnKey(key)) return submitMoveToGroupCreate(state);
  const intent = editableTextInputIntentForInput({ input: key.input, key });
  if (intent.type !== "edit") return { state };
  return {
    state: {
      ...state,
      screen: {
        ...state.screen,
        draftName: transitionEditableTextInput(state.screen.draftName, intent.action),
      },
    },
  };
}

/** Opens the destination sheet for a current canonical dashboard session. */
export function openMoveToGroupForRow(state: DashboardState, rowId: SessionId): DashboardState {
  if (
    state.screen.name !== "dashboard" &&
    !(state.screen.name === "moveToGroup" && state.screen.step === "chooseSlot")
  ) {
    return state;
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined) return state;
  const row = selectDashboardSessionRow(snapshot, rowId);
  if (row === undefined) return state;
  const screen: Extract<MoveToGroupScreen, { step: "chooseDestination" }> = {
    name: "moveToGroup",
    step: "chooseDestination",
    sessionId: row.session.id,
    sessionTitle: sessionRowDisplayTitle(row, state.localRows),
    submitting: false,
  };
  const next = { ...state, screen };
  const context = selectMoveToGroupSessionContext(snapshot, row.session.id);
  const selectedId =
    context?.currentGroup?.parentGroupId === undefined && context?.currentGroup !== undefined
      ? moveToGroupExistingChoiceId(context.currentGroup.id)
      : MOVE_TO_GROUP_UNGROUPED_CHOICE_ID;
  const selection = new Map(next.selection);
  selection.set(MOVE_TO_GROUP_LIST_ID, selectedId);
  return { ...next, selection };
}

export function selectMoveToGroupDestination(
  state: DashboardState,
  destinationGroupId: SessionGroupId | null,
): TuiTransition {
  if (
    state.screen.name !== "moveToGroup" ||
    state.screen.step !== "chooseDestination" ||
    state.screen.submitting
  ) {
    return { state };
  }
  const resolution = resolveMoveSessionToGroupOperation(
    state,
    state.screen.sessionId,
    destinationGroupId,
  );
  if (resolution.kind === "noop") {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  if (resolution.kind === "failure") {
    return { state: addTuiToast(state, { kind: "error", message: resolution.error.message }) };
  }
  return {
    state: { ...state, screen: { ...state.screen, submitting: true } },
    operations: [resolution.operation],
  };
}

export function openMoveToGroupCreate(state: DashboardState): DashboardState {
  if (
    state.screen.name !== "moveToGroup" ||
    state.screen.step !== "chooseDestination" ||
    state.screen.submitting
  ) {
    return state;
  }
  return {
    ...state,
    screen: {
      name: "moveToGroup",
      step: "createGroup",
      sessionId: state.screen.sessionId,
      sessionTitle: state.screen.sessionTitle,
      draftName: createEditableTextInputState(),
      submitting: false,
    },
  };
}

export function submitMoveToGroupCreate(state: DashboardState): TuiTransition {
  if (
    state.screen.name !== "moveToGroup" ||
    state.screen.step !== "createGroup" ||
    state.screen.submitting ||
    state.snapshot === undefined
  ) {
    return { state };
  }
  const name = state.screen.draftName.value.trim();
  if (name.length === 0) return { state };
  const context = selectMoveToGroupSessionContext(state.snapshot, state.screen.sessionId);
  if (context === undefined) return staleSessionTransition(state);
  return {
    state: { ...state, screen: { ...state.screen, submitting: true } },
    operations: [
      {
        type: "createSessionGroupForMove",
        sessionId: context.session.id,
        projectId: context.project.id,
        name,
        previousGroupIds: state.snapshot.sessionGroups.map((group) => group.id),
        command: buildCreateSessionGroupCommand({ projectId: context.project.id, name }),
      },
    ],
  };
}

function backToMoveToGroupDestinations(state: DashboardState): DashboardState {
  if (state.screen.name !== "moveToGroup" || state.screen.step !== "createGroup") return state;
  return {
    ...state,
    screen: {
      name: "moveToGroup",
      step: "chooseDestination",
      sessionId: state.screen.sessionId,
      sessionTitle: state.screen.sessionTitle,
      submitting: false,
    },
  };
}

function cancelMoveToGroup(state: DashboardState): DashboardState {
  if (
    state.screen.name !== "moveToGroup" ||
    (state.screen.step !== "chooseSlot" && state.screen.submitting)
  ) {
    return state;
  }
  return { ...state, screen: { name: "dashboard" } };
}

function staleSessionTransition(state: DashboardState): TuiTransition {
  return {
    state: addTuiToast(
      { ...state, screen: { name: "dashboard" } },
      { kind: "error", message: "The session is no longer available." },
    ),
  };
}
