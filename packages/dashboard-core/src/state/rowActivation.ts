import type { TerminalFocusOrigin, WorktreeRow } from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import { safeErrorToToast } from "../services/errors/errors.js";
import {
  buildFocusCommand,
  buildResumeAgentCommand,
  buildStartAgentCommand,
} from "./commandBuilders.js";
import { addPendingStartAgentRow } from "./localRows.js";
import { addTuiToast } from "./toasts.js";
import type { TuiTransition } from "./transition.js";
import type { TuiState } from "./types.js";

export function activateDashboardRow(state: TuiState, row: WorktreeRow): TuiTransition {
  // Launch (or resume) unless the row has a genuinely live agent to focus. A "?"
  // (unknown) row whose terminal is dead is launchable here, not a dead focus -
  // the dashboard-side half of the observer's relaunch-unknown-rows fix.
  if (row.recovery !== undefined || !worktreeHasLiveAgent(row)) {
    return startOrResumeAgentForRow(state, row);
  }

  if (row.terminal !== undefined && row.terminal.focusable !== true) {
    // The agent's terminal cannot be focused from the dashboard (e.g. it is
    // hosted by Station, whose provider reports canFocusTarget:false). Surface a
    // one-time notice instead of dispatching a focus the provider can only
    // reject, which otherwise spams error toasts on every open keypress.
    return {
      state: addTuiToast(state, {
        kind: "info",
        message: `This agent runs in the "${row.terminal.provider}" terminal and can't be focused from the dashboard.`,
      }),
    };
  }

  return {
    state,
    commands: [buildFocusCommand(row, focusCommandOptions(state.runtime.focusOrigin))],
  };
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
