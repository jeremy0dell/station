import { createEditableTextInputState } from "../../components/EditableTextInput/editing.js";
import {
  selectDashboardSessionRow,
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
} from "../../selectors/selectors.js";
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
  const currentTitle = sessionRowDisplayTitle(resolved, state.localRows);
  const screen: Extract<TuiState["screen"], { name: "renameSession"; step: "editName" }> = {
    name: "renameSession",
    step: "editName",
    rowId: resolved.id,
    sessionId: resolved.session.id,
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

function resolveCurrentRowSession(state: TuiState, rowId: string) {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const direct = selectDashboardSessionRow(snapshot, rowId);
  const worktree = snapshot.rows.find((candidate) => candidate.id === rowId);
  const paneSession =
    worktree === undefined ? undefined : sessionForWorktreeRow(worktree, snapshot.sessions);
  const row =
    direct ??
    (paneSession === undefined ? undefined : selectDashboardSessionRow(snapshot, paneSession.id));
  if (row?.session.origin !== "station") {
    return undefined;
  }
  return row;
}
