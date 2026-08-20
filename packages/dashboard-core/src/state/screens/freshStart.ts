import { type SessionId, worktreeHasLiveAgent } from "@station/contracts";
import {
  selectDashboardSessionRow,
  sessionRowDisplayTitle,
} from "../../selectors/dashboardSessionRows.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardScreenView, DashboardState } from "../types.js";

export type FreshStartActionId = "confirm.startFresh" | "confirm.cancel";

type FreshStartScreenView = Extract<DashboardScreenView, { name: "freshStart" }>;

export const freshStartScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelFreshStart,
};

export function openFreshStartConfirm(state: DashboardState, rowId: SessionId): DashboardState {
  if (state.screen.name !== "dashboard" || state.snapshot === undefined) return state;
  const sessionRow = selectDashboardSessionRow(state.snapshot, rowId);
  if (
    sessionRow === undefined ||
    sessionRow.session.origin !== "station" ||
    sessionRow.worktree.recovery !== undefined
  ) {
    return state;
  }
  return {
    ...state,
    screen: {
      name: "freshStart",
      sessionId: sessionRow.session.id,
      projectId: sessionRow.worktree.projectId,
      worktreeId: sessionRow.worktree.id,
      branch: sessionRow.worktree.branch,
      label:
        sessionRowDisplayTitle(sessionRow, state.localRows).trim() || sessionRow.worktree.branch,
      actionFocus: "cancel",
    },
  };
}

export function handleFreshStartKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "freshStart") return { state };
  if (key.escape === true) return handleFreshStartAction(state, "confirm.cancel");
  if (key.leftArrow === true || key.rightArrow === true) {
    return {
      state: {
        ...state,
        screen: {
          ...state.screen,
          actionFocus: key.leftArrow === true ? "startFresh" : "cancel",
        },
      },
    };
  }
  const input = key.input.toLowerCase();
  if (input === "n") return handleFreshStartAction(state, "confirm.cancel");
  if (input === "y") return handleFreshStartAction(state, "confirm.startFresh");
  if (isReturnKey(key)) {
    return handleFreshStartAction(
      state,
      state.screen.actionFocus === "startFresh" ? "confirm.startFresh" : "confirm.cancel",
    );
  }
  return { state };
}

export function handleFreshStartAction(
  state: DashboardState,
  actionId: FreshStartActionId,
): TuiTransition {
  if (state.screen.name !== "freshStart") return { state };
  if (actionId === "confirm.cancel") return { state: cancelFreshStart(state) };
  return freshStart(state, state.screen);
}

function freshStart(state: DashboardState, screen: FreshStartScreenView): TuiTransition {
  const sessionRow =
    state.snapshot === undefined
      ? undefined
      : selectDashboardSessionRow(state.snapshot, screen.sessionId);
  const session = sessionRow?.session;
  const row = sessionRow?.worktree;
  if (
    session === undefined ||
    row === undefined ||
    session.origin !== "station" ||
    session.projectId !== screen.projectId ||
    session.worktreeId !== screen.worktreeId ||
    row.projectId !== screen.projectId ||
    row.id !== screen.worktreeId ||
    row.branch !== screen.branch ||
    worktreeHasLiveAgent(row) ||
    row.recovery !== undefined
  ) {
    return { state: cancelFreshStart(state) };
  }
  return {
    state: cancelFreshStart(state),
    operations: [
      {
        type: "activateSession",
        sessionId: session.id,
        projectId: row.projectId,
        worktreeId: row.id,
        branch: row.branch,
        preferredObserverAction: "fresh",
        localId: `fresh:${row.id}`,
      },
    ],
  };
}

function cancelFreshStart(state: DashboardState): DashboardState {
  return { ...state, screen: { name: "dashboard" } };
}
