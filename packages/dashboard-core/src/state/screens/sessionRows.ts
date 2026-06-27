import type { SessionView, StationSnapshot, WorktreeRow } from "@station/contracts";
import { createEditableTextInputState } from "../../components/EditableTextInput/editing.js";
import { sessionForWorktreeRow, worktreeRowDisplayTitle } from "../../selectors/selectors.js";
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
