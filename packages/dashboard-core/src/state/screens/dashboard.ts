import { createNewSessionFlow, createNewSessionNameToken } from "../../flows/newSession.js";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { scrollDashboard } from "../dashboardScroll.js";
import { matchTuiBinding, type TuiBinding } from "../keymap.js";
import type { TuiKey } from "../keys.js";
import { activateDashboardRow } from "../rowActivation.js";
import { addTuiToast } from "../toasts.js";
import type { TuiKeyRuntimeContext, TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { openAddProject } from "./addProjectScreen.js";
import { openProjectSlotPicker } from "./projectSlotPicker.js";

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
    case "tui.fork.open":
      return {
        state: {
          ...state,
          screen: { name: "fork", step: "chooseSlot" },
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
      return openProjectSlotPicker(state, "projectCollapse");
    case "tui.projectSettings.openPicker":
      return openProjectSlotPicker(state, "projectSettingsPicker");
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

  return activateDashboardRow(state, row);
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
