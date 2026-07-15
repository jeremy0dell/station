import { isRunningAgentState, type SessionId, type StationSnapshot } from "@station/contracts";
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
import type { TuiState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";

export function handleRemoveWorktreeKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeWorktree") {
    return { state };
  }

  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
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
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  return handleConfirmKey(state, key);
}

export function isExternalAgentRemovalUnavailable(
  row: DashboardSessionRow,
  snapshot: StationSnapshot,
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
    },
  };
}

function handleConfirmKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "removeWorktree" || state.screen.step !== "confirm") {
    return { state };
  }

  const input = key.input.toLowerCase();

  if (input === "n" || key.escape === true || isReturnKey(key)) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  if (input !== "y") {
    return { state };
  }

  const screen = state.screen;
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

function removeWorktreeForceRequired(row: DashboardSessionRow, snapshot: StationSnapshot): boolean {
  return (
    cleanupForceRequired(row.worktree, "remove-worktree") ||
    snapshot.sessions.some(
      (session) =>
        session.worktreeId === row.worktree.id && isRunningAgentState(session.status.value),
    )
  );
}
