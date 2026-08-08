import type { WorktreeRow } from "@station/contracts";
import { createEditableTextInputState } from "../../components/EditableTextInput/editing.js";
import {
  selectDashboardSessionRow,
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
} from "../../selectors/dashboardSessionRows.js";
import type { DashboardState } from "../types.js";

export type OpenRenameEditForRowOptions = {
  returnTo?: "dashboard";
};

export function openRenameEditForRow(
  state: DashboardState,
  rowId: string,
  options: OpenRenameEditForRowOptions = {},
): DashboardState {
  if (!canOpenRenameFromScreen(state)) {
    return state;
  }
  const resolved = resolveCurrentRowSession(state, rowId);
  if (resolved === undefined) {
    return state;
  }
  const currentTitle = sessionRowDisplayTitle(resolved, state.localRows);
  const screen: Extract<DashboardState["screen"], { name: "renameSession"; step: "editName" }> = {
    name: "renameSession",
    step: "editName",
    rowId: resolved.id,
    sessionId: resolved.session.id,
    currentTitle,
    draftTitle: createEditableTextInputState(),
  };
  if (options.returnTo !== undefined) {
    screen.returnTo = options.returnTo;
  }
  return { ...state, screen };
}

function canOpenRenameFromScreen(state: DashboardState): boolean {
  return (
    state.screen.name === "dashboard" ||
    (state.screen.name === "renameSession" && state.screen.step === "chooseSlot")
  );
}

function resolveCurrentRowSession(state: DashboardState, rowId: string) {
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const direct = selectDashboardSessionRow(snapshot, rowId);
  const worktree = snapshot.rows.find((candidate: WorktreeRow) => candidate.id === rowId);
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
