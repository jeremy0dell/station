import {
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { buildRenameSessionCommand } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import { addPendingRenameSessionTitle } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";
import { openRenameEditForRow } from "./sessionRows.js";

function handleChooseSlotKey(state: TuiState, key: TuiKey): TuiTransition {
  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }
  return handleDashboardRowChoiceKey(state, key, (current, rowId) => {
    const next = openRenameEditForRow(current, rowId);
    return next === current
      ? {
          state: addTuiToast(current, {
            kind: "error",
            message: "No session exists for that row.",
          }),
        }
      : { state: next };
  });
}

function handleEditNameKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "renameSession" || state.screen.step !== "editName") {
    return { state };
  }

  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen:
          state.screen.returnTo === "dashboard"
            ? { name: "dashboard" }
            : { name: "renameSession", step: "chooseSlot" },
      },
    };
  }

  if (isReturnKey(key)) {
    return submitRename(state);
  }

  const intent = editableTextInputIntentForInput({ input: key.input, key });
  if (intent.type !== "edit") {
    return { state };
  }

  return {
    state: {
      ...state,
      screen: renameEditScreen({
        screen: state.screen,
        draftTitle: transitionEditableTextInput(state.screen.draftTitle, intent.action),
      }),
    },
  };
}

function submitRename(state: TuiState): TuiTransition {
  if (state.screen.name !== "renameSession" || state.screen.step !== "editName") {
    return { state };
  }

  const title = state.screen.draftTitle.value.trim();
  if (title.length === 0) {
    return {
      state: {
        ...state,
        screen: {
          ...state.screen,
          validationError: "Session title cannot be empty.",
        },
      },
    };
  }

  if (title === state.screen.currentTitle.trim()) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  const command = buildRenameSessionCommand({
    sessionId: state.screen.sessionId,
    title,
  });
  if (command.type !== "session.rename") {
    return { state };
  }

  return {
    state: addPendingRenameSessionTitle(
      {
        ...state,
        screen: { name: "dashboard" },
      },
      {
        sessionId: state.screen.sessionId,
        title,
        createdAt: new Date().toISOString(),
      },
    ),
    operations: [
      {
        type: "renameSession",
        sessionId: state.screen.sessionId,
        title,
        command,
      },
    ],
  };
}

export function handleRenameSessionKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "renameSession") {
    return { state };
  }

  if (state.screen.step === "chooseSlot") {
    return handleChooseSlotKey(state, key);
  }

  return handleEditNameKey(state, key);
}

function renameEditScreen(input: {
  screen: Extract<TuiState["screen"], { name: "renameSession"; step: "editName" }>;
  draftTitle: Extract<
    TuiState["screen"],
    { name: "renameSession"; step: "editName" }
  >["draftTitle"];
}): Extract<TuiState["screen"], { name: "renameSession"; step: "editName" }> {
  const screen: Extract<TuiState["screen"], { name: "renameSession"; step: "editName" }> = {
    name: "renameSession",
    step: "editName",
    rowId: input.screen.rowId,
    sessionId: input.screen.sessionId,
    currentTitle: input.screen.currentTitle,
    draftTitle: input.draftTitle,
  };
  if (input.screen.returnTo !== undefined) {
    screen.returnTo = input.screen.returnTo;
  }
  return screen;
}
