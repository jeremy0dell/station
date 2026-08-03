import { isRunningAgentState, type SessionId } from "@station/contracts";
import {
  type DashboardSessionRow,
  selectDashboardSessionRow,
  sessionRowDisplayTitle,
} from "../../selectors/selectors.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { buildRemoveWorktreeCommand, cleanupForceRequired } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import { addPendingRemoveWorktreeRow } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardScreenView, DashboardSnapshotView, TuiState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";

type RemoveWorktreeScreen = Extract<TuiState["screen"], { name: "removeWorktree" }>;
type RemoveWorktreeScreenView = Extract<DashboardScreenView, { name: "removeWorktree" }>;

export type RemoveWorktreeActionId = "confirm.delete" | "confirm.keep";

const removeWorktreeChooseSlotBehavior = {};
const removeWorktreeDismissBehavior = { clickAway: cancelRemoveWorktree };

export function removeWorktreeScreenBehavior(screen: RemoveWorktreeScreenView) {
  switch (screen.step) {
    case "chooseSlot":
      return removeWorktreeChooseSlotBehavior;
    case "unavailable":
    case "confirm":
      return removeWorktreeDismissBehavior;
  }
  return assertNever(screen);
}

export function handleRemoveWorktreeKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeWorktree") {
    return { state };
  }

  if (key.escape === true) {
    return state.screen.step === "confirm"
      ? handleRemoveWorktreeAction(state, "confirm.keep")
      : { state: cancelRemoveWorktree(state) };
  }

  if (state.screen.step === "chooseSlot") {
    return handleDashboardRowChoiceKey(state, key, (current, rowId) => ({
      state: openRemoveWorktreeConfirmForRow(current, rowId),
    }));
  }

  if (state.screen.step === "unavailable") {
    if (!isReturnKey(key)) {
      return { state };
    }
    return { state: cancelRemoveWorktree(state) };
  }

  return handleConfirmKey(state, key);
}

export function isExternalAgentRemovalUnavailable(
  row: DashboardSessionRow,
  snapshot: DashboardSnapshotView,
): boolean {
  return snapshot.sessions.some(
    (session) =>
      session.worktreeId === row.worktree.id &&
      session.origin === "external" &&
      isRunningAgentState(session.status.value) &&
      snapshot.providerHealth[session.harness.provider]?.capabilities?.canStop === false &&
      session.terminal?.closeable !== true,
  );
}

export function openRemoveWorktreeConfirmForRow(state: TuiState, rowId: SessionId): TuiState {
  if (state.screen.name !== "dashboard" && state.screen.name !== "removeWorktree") {
    return state;
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return state;
  }
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined) {
    return state;
  }
  const row = sessionRow.worktree;
  if (isExternalAgentRemovalUnavailable(sessionRow, snapshot)) {
    return {
      ...state,
      screen: {
        name: "removeWorktree",
        step: "unavailable",
      },
    };
  }
  const label = sessionRowDisplayTitle(sessionRow, state.localRows).trim() || row.branch;
  return {
    ...state,
    screen: {
      name: "removeWorktree",
      step: "confirm",
      rowId: sessionRow.id,
      forceRequired: removeWorktreeForceRequired(sessionRow, snapshot),
      label,
      actionFocus: "keep",
    },
  };
}

function handleConfirmKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeWorktree" || state.screen.step !== "confirm") {
    return { state };
  }

  if (key.leftArrow === true || key.rightArrow === true) {
    const actionFocus = key.leftArrow === true ? "delete" : "keep";
    return { state: { ...state, screen: { ...state.screen, actionFocus } } };
  }

  const input = key.input.toLowerCase();
  if (input === "n") {
    return handleRemoveWorktreeAction(state, "confirm.keep");
  }
  if (input === "y") {
    return handleRemoveWorktreeAction(state, "confirm.delete");
  }
  if (isReturnKey(key)) {
    return handleRemoveWorktreeAction(
      state,
      state.screen.actionFocus === "delete" ? "confirm.delete" : "confirm.keep",
    );
  }
  return { state };
}

/** Applies a visible Remove confirmation action after validating the active screen. */
export function handleRemoveWorktreeAction(
  state: TuiState,
  actionId: RemoveWorktreeActionId,
): TuiTransition {
  if (state.screen.name !== "removeWorktree" || state.screen.step !== "confirm") {
    return { state };
  }
  switch (actionId) {
    case "confirm.keep":
      return { state: cancelRemoveWorktree(state) };
    case "confirm.delete":
      return deleteRemoveWorktree(state, state.screen);
  }
}

function deleteRemoveWorktree(
  state: TuiState,
  screen: Extract<RemoveWorktreeScreen, { step: "confirm" }>,
): TuiTransition {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }
  const sessionRow = selectDashboardSessionRow(snapshot, screen.rowId);
  if (sessionRow === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }
  const row = sessionRow.worktree;
  if (isExternalAgentRemovalUnavailable(sessionRow, snapshot)) {
    return {
      state: {
        ...state,
        screen: { name: "removeWorktree", step: "unavailable" },
      },
    };
  }
  if (row.registrationIdentity === undefined) {
    return {
      state: addTuiToast(
        {
          ...state,
          screen: { name: "dashboard" },
        },
        safeErrorToToast({
          tag: "CommandValidationError",
          code: "WORKTREE_REMOVE_REGISTRATION_UNVERIFIED",
          message: "Station cannot verify this checkout's Git registration.",
          hint: "Refresh the dashboard before trying to remove the checkout.",
          projectId: row.projectId,
          worktreeId: row.id,
        }),
      ),
    };
  }

  const command = buildRemoveWorktreeCommand(
    row,
    screen.forceRequired || removeWorktreeForceRequired(sessionRow, snapshot),
  );
  if (command.type !== "worktree.remove") {
    return { state };
  }
  const localId = `remove:${row.id}`;

  return {
    state: addPendingRemoveWorktreeRow(
      {
        ...state,
        screen: { name: "dashboard" },
      },
      {
        localId,
        projectId: row.projectId,
        worktreeId: row.id,
        branch: row.branch,
        createdAt: new Date().toISOString(),
      },
    ),
    operations: [
      {
        type: "removeWorktree",
        localId,
        projectId: row.projectId,
        worktreeId: row.id,
        branch: row.branch,
        command,
      },
    ],
  };
}

function removeWorktreeForceRequired(
  row: DashboardSessionRow,
  snapshot: DashboardSnapshotView,
): boolean {
  return (
    cleanupForceRequired(row.worktree, "remove-worktree") ||
    snapshot.sessions.some(
      (session) =>
        session.worktreeId === row.worktree.id && isRunningAgentState(session.status.value),
    )
  );
}

function cancelRemoveWorktree(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}

function assertNever(_value: never): never {
  throw new Error("Unhandled Remove Worktree screen variant.");
}
