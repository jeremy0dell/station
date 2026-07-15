import type { TerminalFocusOrigin, WorktreeRow } from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import type { DashboardSessionRow } from "../selectors/selectors.js";
import { safeErrorToToast } from "../services/errors/errors.js";
import {
  buildResumeAgentCommand,
  buildSessionFocusCommand,
  buildStartAgentCommand,
} from "./commandBuilders.js";
import { addPendingStartAgentRow } from "./localRows.js";
import { addTuiToast } from "./toasts.js";
import type { TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

export function activateDashboardRow(
  state: TuiState,
  sessionRow: DashboardSessionRow,
): TuiTransition {
  const { presentation: row, session, worktree } = sessionRow;
  // Launch (or resume) unless the row has a genuinely live agent to focus. A "?"
  // (unknown) row whose terminal is dead is launchable here, not a dead focus -
  // the dashboard-side half of the observer's relaunch-unknown-rows fix.
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
    return startOrResumeAgentForRow(state, worktree);
  }

  if (session.terminal?.focusable !== true) {
    // The agent's terminal cannot be focused from the dashboard (e.g. it is
    // hosted by Station, whose provider reports canFocusTarget:false). Surface a
    // one-time notice instead of dispatching a focus the provider can only
    // reject, which otherwise spams error toasts on every open keypress.
    return {
      state: addTuiToast(state, {
        kind: "info",
        message:
          session.terminal === undefined
            ? "This session has no focusable terminal."
            : `This agent runs in the "${session.terminal.provider}" terminal and can't be focused from the dashboard.`,
      }),
    };
  }

  return {
    state,
    commands: [buildSessionFocusCommand(session, focusCommandOptions(state.runtime.focusOrigin))],
  };
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

function startOrResumeAgentForRow(state: TuiState, row: WorktreeRow): TuiTransition {
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

  if (row.recovery !== undefined) {
    const command = buildResumeAgentCommand(row, project);
    const localId = `resume:${row.id}`;
    return {
      state: addPendingStartAgentRow(state, {
        localId,
        operation: "resumeAgent",
        projectId: row.projectId,
        worktreeId: row.id,
        branch: row.branch,
        createdAt: new Date().toISOString(),
      }),
      operations: [
        {
          type: "resumeAgent",
          localId,
          projectId: row.projectId,
          worktreeId: row.id,
          branch: row.branch,
          command,
        },
      ],
    };
  }

  const command = buildStartAgentCommand(row, project);
  const localId = `start:${row.id}`;
  return {
    state: addPendingStartAgentRow(state, {
      localId,
      operation: "startAgent",
      projectId: row.projectId,
      worktreeId: row.id,
      branch: row.branch,
      createdAt: new Date().toISOString(),
    }),
    operations: [
      {
        type: "startAgent",
        localId,
        projectId: row.projectId,
        worktreeId: row.id,
        branch: row.branch,
        command,
      },
    ],
  };
}

function focusCommandOptions(focusOrigin: TerminalFocusOrigin | undefined): {
  origin?: TerminalFocusOrigin;
} {
  const options: { origin?: TerminalFocusOrigin } = {};
  if (focusOrigin !== undefined) {
    options.origin = focusOrigin;
  }
  return options;
}
