import { worktreeRowDisplayTitle } from "../../selectors/selectors.js";
import { buildRemoveWorktreeCommand, cleanupForceRequired } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import { addPendingRemoveWorktreeRow } from "../localRows.js";
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

  return handleConfirmKey(state, key);
}

export function openRemoveWorktreeConfirmForRow(state: TuiState, rowId: string): TuiState {
  if (state.screen.name !== "dashboard" && state.screen.name !== "removeWorktree") {
    return state;
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return state;
  }
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    return state;
  }
  const label =
    worktreeRowDisplayTitle(row, snapshot.sessions, state.localRows).trim() || row.branch;
  return {
    ...state,
    screen: {
      name: "removeWorktree",
      step: "confirm",
      rowId: row.id,
      forceRequired: cleanupForceRequired(row, "remove-worktree"),
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
  const row = state.snapshot?.rows.find((candidate) => candidate.id === screen.rowId);
  if (row === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  const command = buildRemoveWorktreeCommand(row, screen.forceRequired);
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
