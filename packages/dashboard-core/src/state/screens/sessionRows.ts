import {
  isRunningAgentState,
  type SessionView,
  type StationCommand,
  type StationSnapshot,
  type WorktreeRow,
} from "@station/contracts";
import { createEditableTextInputState } from "../../components/EditableTextInput/editing.js";
import { sessionForWorktreeRow, worktreeRowDisplayTitle } from "../../selectors/selectors.js";
import { buildRemoveSessionCommand } from "../commandBuilders.js";
import type { TuiState } from "../types.js";

export type OpenRenameEditForRowOptions = {
  returnTo?: "dashboard";
};

export function openRenameEditForRow(
  state: TuiState,
  rowId: string,
  options: OpenRenameEditForRowOptions = {},
): TuiState {
  if (!canOpenRenameFromScreen(state)) {
    return state;
  }
  const resolved = resolveCurrentRowSession(state, rowId);
  if (resolved === undefined) {
    return state;
  }
  const { row, session, snapshot } = resolved;
  const currentTitle = worktreeRowDisplayTitle(row, snapshot.sessions, state.localRows);
  const screen: Extract<TuiState["screen"], { name: "renameSession"; step: "editName" }> = {
    name: "renameSession",
    step: "editName",
    rowId: row.id,
    sessionId: session.id,
    currentTitle,
    draftTitle: createEditableTextInputState(currentTitle),
  };
  if (options.returnTo !== undefined) {
    screen.returnTo = options.returnTo;
  }
  return { ...state, screen };
}

export function openRemoveSessionConfirmForRow(state: TuiState, rowId: string): TuiState {
  if (state.screen.name !== "dashboard") {
    return state;
  }
  const resolved = resolveCurrentRowSession(state, rowId);
  if (resolved === undefined) {
    return state;
  }
  const { row, session, snapshot } = resolved;
  const title = worktreeRowDisplayTitle(row, snapshot.sessions, state.localRows).trim();
  const label = title.length > 0 ? title : row.branch;
  return {
    ...state,
    screen: {
      name: "removeSession",
      rowId: row.id,
      sessionId: session.id,
      forceRequired: isRunningAgentState(row.agent?.state ?? session.status.value),
      label,
    },
  };
}

export function removeSessionCommandForCurrentScreen(
  state: TuiState,
): Extract<StationCommand, { type: "session.remove" }> | undefined {
  if (state.screen.name !== "removeSession") {
    return undefined;
  }
  const screen = state.screen;
  const resolved = resolveCurrentRowSession(state, screen.rowId);
  if (resolved === undefined || resolved.session.id !== screen.sessionId) {
    return undefined;
  }
  return buildRemoveSessionCommand({
    sessionId: resolved.session.id,
    force: screen.forceRequired,
  });
}

function canOpenRenameFromScreen(state: TuiState): boolean {
  return (
    state.screen.name === "dashboard" ||
    (state.screen.name === "renameSession" && state.screen.step === "chooseSlot")
  );
}

function resolveCurrentRowSession(
  state: TuiState,
  rowId: string,
): { row: WorktreeRow; session: SessionView; snapshot: StationSnapshot } | undefined {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    return undefined;
  }
  const session = sessionForWorktreeRow(row, snapshot.sessions);
  if (session === undefined) {
    return undefined;
  }
  return { row, session, snapshot };
}
