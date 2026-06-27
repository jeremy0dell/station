import type { TerminalFocusOrigin } from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import { createNewSessionFlow, createNewSessionNameToken } from "../../flows/newSession.js";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import {
  choiceValueByKey,
  type KeyedChoice,
  selectProjectChoices,
} from "../../selectors/selectors.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import {
  buildFocusCommand,
  buildResumeAgentCommand,
  buildStartAgentCommand,
} from "../commandBuilders.js";
import { scrollDashboard } from "../dashboardScroll.js";
import { matchTuiBinding, type TuiBinding } from "../keymap.js";
import type { TuiKey } from "../keys.js";
import { addPendingStartAgentRow } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import type { TuiKeyRuntimeContext, TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { openAddProject } from "./addProjectScreen.js";

export function handleDashboardKey(
  state: TuiState,
  key: TuiKey,
  context: TuiKeyRuntimeContext,
): TuiTransition {
  const mouseScrollDelta = mouseScrollDeltaForKey(key);
  if (mouseScrollDelta !== 0) {
    return {
      state: scrollDashboard(state, mouseScrollDelta),
    };
  }

  const binding = matchTuiBinding("dashboard", key);
  if (binding === undefined) {
    return { state };
  }

  return handleDashboardBinding(state, key, binding, context);
}

function handleDashboardBinding(
  state: TuiState,
  key: TuiKey,
  binding: TuiBinding<"dashboard">,
  context: TuiKeyRuntimeContext,
): TuiTransition {
  switch (binding.action) {
    case "tui.view.scrollUp":
      return {
        state: scrollDashboard(state, -1),
      };
    case "tui.view.scrollDown":
      return {
        state: scrollDashboard(state, 1),
      };
    case "tui.help.open":
      return {
        state: {
          ...state,
          screen: { name: "help" },
        },
      };
    case "tui.exit":
      return exitOrDismissPopup(state);
    case "tui.popup.dismiss":
      return state.runtime.persistentPopup && state.runtime.canDismissPopup
        ? { state, dismissPopup: true }
        : { state };
    case "tui.search.open":
      return {
        state: {
          ...state,
          screen: { name: "search", value: "" },
        },
      };
    case "tui.rename.open":
      return {
        state: {
          ...state,
          screen: { name: "renameSession", step: "chooseSlot" },
        },
      };
    case "tui.refresh":
      return {
        state,
        reconcileReason: "tui-refresh",
      };
    case "tui.remove.open":
      return {
        state: {
          ...state,
          screen: { name: "removeWorktree", step: "chooseSlot" },
        },
      };
    case "tui.newSession.open":
      return openNewSession(state);
    case "tui.addProject.open":
      return {
        state: openAddProject(state, context),
      };
    case "tui.collapse.open":
      return openProjectCollapse(state);
    case "tui.row.activateSlot":
      return activateDashboardSlot(state, key);
    default:
      return assertNever(binding);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled dashboard binding: ${JSON.stringify(value)}`);
}

function exitOrDismissPopup(state: TuiState): TuiTransition {
  if (state.runtime.persistentPopup && state.runtime.canDismissPopup) {
    return {
      state,
      dismissPopup: true,
    };
  }

  return {
    state,
    exitCode: 0,
  };
}

function activateDashboardSlot(state: TuiState, key: TuiKey): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const row = choiceValueByKey(
    selectDashboardViewport(state.snapshot, state).rowChoices,
    key.input,
  );
  if (row === undefined) {
    return { state };
  }

  // Launch (or resume) unless the row has a genuinely live agent to focus. A "?"
  // (unknown) row whose terminal is dead is launchable here, not a dead focus —
  // the dashboard-side half of the observer's relaunch-unknown-rows fix.
  if (row.recovery !== undefined || !worktreeHasLiveAgent(row)) {
    return startOrResumeAgentForRow(state, row);
  }

  if (row.terminal !== undefined && row.terminal.focusable !== true) {
    // The agent's terminal cannot be focused from the dashboard (e.g. it is
    // hosted by Station, whose provider reports canFocusTarget:false). Surface a
    // one-time notice instead of dispatching a focus the provider can only
    // reject — which otherwise spams error toasts on every open keypress.
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

export function scrollDeltaForKey(key: TuiKey): -1 | 0 | 1 {
  if (key.upArrow === true || key.mouseScroll === "up") {
    return -1;
  }
  if (key.downArrow === true || key.mouseScroll === "down") {
    return 1;
  }
  return 0;
}

function mouseScrollDeltaForKey(key: TuiKey): -1 | 0 | 1 {
  if (key.mouseScroll === "up") {
    return -1;
  }
  if (key.mouseScroll === "down") {
    return 1;
  }
  return 0;
}

function openNewSession(state: TuiState): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const flow = createNewSessionFlow(state.snapshot, createNewSessionNameToken());
  if (flow === undefined) {
    return {
      state: addTuiToast(
        state,
        safeErrorToToast({
          tag: "CommandValidationError",
          code: "PROJECT_NOT_CONFIGURED",
          message: "No project is configured for a new session.",
          hint: "Add a project to config.toml and run station reconcile.",
        }),
      ),
    };
  }

  return {
    state: {
      ...state,
      screen: { name: "newSession", flow },
    },
  };
}

function openProjectCollapse(state: TuiState): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }
  return {
    state: {
      ...state,
      screen: {
        name: "projectCollapse",
        value: formatProjectChoicePrompt(selectProjectChoices(state.snapshot, state)),
      },
    },
  };
}

function startOrResumeAgentForRow(
  state: TuiState,
  row: NonNullable<TuiState["snapshot"]>["rows"][number],
): TuiTransition {
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

function formatProjectChoicePrompt(choices: ReadonlyArray<KeyedChoice<{ label: string }>>): string {
  return choices.map((choice) => `${choice.key}:${choice.value.label}`).join(" ");
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
