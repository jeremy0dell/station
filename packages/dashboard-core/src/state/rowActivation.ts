import { type WorktreeRow, worktreeHasLiveAgent } from "@station/contracts";
import {
  type DashboardSessionRow,
  selectDashboardSessionRow,
} from "../selectors/dashboardSessionRows.js";
import { safeErrorToToast } from "../services/errors/errors.js";
import { addTuiToast, STALE_DASHBOARD_TARGET_NOTICE } from "./toasts.js";
import type { TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

/** Resolve a stable dashboard row identity before producing one activation operation. */
export function activateDashboardRowById(state: TuiState, rowId: string): TuiTransition {
  const sessionRow =
    state.snapshot === undefined ? undefined : selectDashboardSessionRow(state.snapshot, rowId);
  if (sessionRow === undefined) {
    return {
      state: addTuiToast(state, STALE_DASHBOARD_TARGET_NOTICE),
    };
  }
  if (
    state.localRows.pendingStart.some((pending) => pending.worktreeId === sessionRow.worktree.id) ||
    state.localRows.pendingRemove.some((pending) => pending.worktreeId === sessionRow.worktree.id)
  ) {
    return { state };
  }
  return activateDashboardRow(state, sessionRow);
}

/** Resolve a stable session identity before delegating row-scoped shell execution. */
export function openDashboardRowShell(state: TuiState, rowId: string): TuiTransition {
  const sessionRow =
    state.snapshot === undefined ? undefined : selectDashboardSessionRow(state.snapshot, rowId);
  if (sessionRow === undefined) {
    return {
      state: addTuiToast(state, STALE_DASHBOARD_TARGET_NOTICE),
    };
  }
  return {
    state,
    operations: [
      {
        type: "openDashboardShell",
        target: { kind: "session", sessionId: sessionRow.session.id },
      },
    ],
  };
}

export function activateDashboardRow(
  state: TuiState,
  sessionRow: DashboardSessionRow,
): TuiTransition {
  const { presentation: row, session, worktree } = sessionRow;
  // Unknown rows whose terminal is dead remain launchable; the selected renderer
  // revalidates this stable identity before choosing its activation mechanics.
  if (!worktreeHasLiveAgent(row)) {
    if (session.origin === "external") {
      return {
        state: addTuiToast(state, {
          kind: "info",
          message: "This external session is no longer active. Refresh the dashboard.",
        }),
      };
    }
    if (otherSessionHasLiveAgent(sessionRow)) {
      return {
        state: addTuiToast(state, {
          kind: "info",
          message: "Another session is already active in this checkout.",
        }),
      };
    }
  }
  return activationOperation(state, session.id, worktree);
}

function otherSessionHasLiveAgent(row: DashboardSessionRow): boolean {
  if (!worktreeHasLiveAgent(row.worktree)) {
    return false;
  }
  if (row.session.origin === "station") {
    return row.worktree.agent?.sessionId !== row.session.id;
  }
  return row.worktree.agent?.runId !== row.session.harness.runId;
}

function activationOperation(state: TuiState, sessionId: string, row: WorktreeRow): TuiTransition {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === row.projectId);
  if (project === undefined) {
    return {
      state: addTuiToast(
        state,
        safeErrorToToast({
          tag: "CommandValidationError",
          code: "PROJECT_NOT_FOUND",
          message: `Project not found for worktree ${row.id}.`,
        }),
      ),
    };
  }
  const preferredObserverAction = worktreeHasLiveAgent(row)
    ? "focus"
    : row.recovery === undefined
      ? "start"
      : "resume";
  const localId =
    preferredObserverAction === "focus" ? undefined : `${preferredObserverAction}:${row.id}`;
  return {
    state,
    operations: [
      {
        type: "activateSession",
        sessionId,
        projectId: project.id,
        worktreeId: row.id,
        branch: row.branch,
        preferredObserverAction,
        ...(localId === undefined ? {} : { localId }),
      },
    ],
  };
}
