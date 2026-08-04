import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import {
  DASHBOARD_FILTER_CONDITION_FIELDS,
  dashboardPersistentFilterHasCriteria,
  normalizeDashboardFilterConditions,
} from "../../selectors/dashboardFilterConditions.js";
import { reconcileDashboardFocus } from "../dashboardFocus.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import {
  cancelPersistentFilterConditionEditor,
  handlePersistentFilterConditionKey,
  openPersistentFilterConditionEditor,
} from "./persistentFilterConditions.js";

const persistentFilterEditingScreenBehavior = { dashboardHoverEnabled: false };
const persistentFilterConditionScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelPersistentFilterConditionEditor,
};

export function persistentFilterScreenBehavior(
  screen: Extract<TuiState["screen"], { name: "persistentFilter" }>,
) {
  return screen.conditionEditor === undefined
    ? persistentFilterEditingScreenBehavior
    : persistentFilterConditionScreenBehavior;
}

export function openDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "dashboard") {
    return { state };
  }
  const next: TuiState = {
    ...state,
    screen: {
      name: "persistentFilter",
      draft: createEditableTextInputState(state.persistentFilter?.query ?? ""),
      draftConditions: normalizeDashboardFilterConditions(state.persistentFilter?.conditions ?? []),
    },
  };
  return { state: reconcileDashboardFocus(state, next) };
}

export function handleDashboardPersistentFilterKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }

  if (isCompleteDraftClearKey(key)) {
    return {
      state: {
        ...state,
        screen: {
          name: "persistentFilter",
          draft: createEditableTextInputState(),
          draftConditions: [],
        },
      },
    };
  }

  if (state.screen.conditionEditor !== undefined) {
    if (isConditionFilterApplyKey(state.screen, key)) {
      return applyDashboardPersistentFilter(state);
    }
    return { state: handlePersistentFilterConditionKey(state, key) };
  }

  if (key.escape === true) {
    return cancelDashboardPersistentFilter(state);
  }

  if (isConditionEditorKey(key)) {
    return { state: openPersistentFilterConditionEditor(state) };
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

export function applyDashboardPersistentFilter(state: TuiState): TuiTransition {
  if (state.screen.name !== "persistentFilter") {
    return { state };
  }
  const query = state.screen.draft.value.trim();
  const conditions = normalizeDashboardFilterConditions(state.screen.draftConditions);
  if (dashboardPersistentFilterHasCriteria({ query, conditions })) {
    const persistentFilter = conditions.length === 0 ? { query } : { query, conditions };
    const next: TuiState = {
      ...state,
      persistentFilter,
      screen: { name: "dashboard" },
    };
    return { state: reconcileDashboardFocus(state, next) };
  }
  return clearPersistentFilterState(state);
}

function isConditionFilterApplyKey(
  screen: Extract<TuiState["screen"], { name: "persistentFilter" }>,
  key: TuiKey,
): boolean {
  const editor = screen.conditionEditor;
  return (
    editor?.stage === "field" &&
    (key.input.toUpperCase() === "F" ||
      (isReturnKey(key) && editor.cursor === DASHBOARD_FILTER_CONDITION_FIELDS.length))
  );
}

function isConditionEditorKey(key: TuiKey): boolean {
  return key.input === "\t" || (key.ctrl === true && key.input.toLowerCase() === "i");
}

function isCompleteDraftClearKey(key: TuiKey): boolean {
  return key.ctrl === true && key.input.toLowerCase() === "u";
}

function clearPersistentFilterState(state: TuiState): TuiTransition {
  const { persistentFilter: _removed, ...withoutPersistentFilter } = state;
  const next: TuiState = {
    ...withoutPersistentFilter,
    screen: { name: "dashboard" },
  };
  return { state: reconcileDashboardFocus(state, next) };
}
