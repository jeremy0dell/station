import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const persistentFilterScreenBehavior = {};

export function openDashboardPersistentFilter(state: TuiState): TuiTransition {
  return {
    state: {
      ...state,
      screen: {
        name: "persistentFilter",
        draft: createEditableTextInputState(state.persistentFilter?.query ?? ""),
      },
    },
  };
}

export function handleDashboardPersistentFilterKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }

  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  if (isReturnKey(key)) {
    return applyDashboardPersistentFilter(state);
  }

  const intent = editableTextInputIntentForInput({ input: key.input, key });
  if (intent.type === "none") {
    return { state };
  }

  return {
    state: {
      ...state,
      screen: {
        ...state.screen,
        draft: transitionEditableTextInput(state.screen.draft, intent.action),
      },
    },
  };
}

function applyDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }
  const query = state.screen.draft.value.trim();
  if (query.length > 0) {
    return {
      state: {
        ...state,
        persistentFilter: { query },
        screen: { name: "dashboard" },
      },
    };
  }

  const { persistentFilter: _removed, ...withoutPersistentFilter } = state;
  return {
    state: {
      ...withoutPersistentFilter,
      screen: { name: "dashboard" },
    },
  };
}
