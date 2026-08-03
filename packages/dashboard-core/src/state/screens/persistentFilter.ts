import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { reconcileDashboardFocus } from "../dashboardFocus.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const persistentFilterScreenBehavior = {};

export function openDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "dashboard") {
    return { state };
  }
  const next: TuiState = {
    ...state,
    screen: {
      name: "persistentFilter",
      draft: createEditableTextInputState(state.persistentFilter?.query ?? ""),
    },
  };
  return { state: reconcileDashboardFocus(state, next) };
}

export function handleDashboardPersistentFilterKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }

  if (key.escape === true) {
    return cancelDashboardPersistentFilter(state);
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

/** Clears applied state through the same projection reconciliation used by keyboard Escape. */
export function clearDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "dashboard" || state.persistentFilter === undefined) {
    return { state };
  }
  return clearPersistentFilterState(state);
}

function cancelDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }
  const next: TuiState = { ...state, screen: { name: "dashboard" } };
  return { state: reconcileDashboardFocus(state, next) };
}

function applyDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }
  const query = state.screen.draft.value.trim();
  if (query.length > 0) {
    const next: TuiState = {
      ...state,
      persistentFilter: { query },
      screen: { name: "dashboard" },
    };
    return { state: reconcileDashboardFocus(state, next) };
  }
  return clearPersistentFilterState(state);
}

function clearPersistentFilterState(state: TuiState): TuiTransition {
  const { persistentFilter: _removed, ...withoutPersistentFilter } = state;
  const next: TuiState = {
    ...withoutPersistentFilter,
    screen: { name: "dashboard" },
  };
  return { state: reconcileDashboardFocus(state, next) };
}
