import type { AgentState, ProjectId, ProviderId } from "@station/contracts";
import {
  DASHBOARD_FILTER_CONDITION_FIELDS,
  dashboardFilterConditionSlot,
  normalizeDashboardFilterConditions,
  selectDashboardFilterConditionOptions,
} from "../../selectors/dashboardFilterConditions.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type {
  DashboardFilterCondition,
  DashboardFilterConditionField,
  DashboardFilterConditionOption,
  TuiState,
} from "../types.js";

export function openPersistentFilterConditionEditor(state: TuiState): TuiState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor !== undefined) {
    return state;
  }
  return {
    ...state,
    screen: { ...state.screen, conditionEditor: { stage: "field", cursor: 0 } },
  };
}

export function handlePersistentFilterConditionKey(state: TuiState, key: TuiKey): TuiState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  if (key.escape === true) {
    return cancelPersistentFilterConditionEditor(state);
  }
  const editor = state.screen.conditionEditor;
  if (editor.stage === "field") {
    const directField = conditionFieldForKey(key.input);
    if (directField !== undefined) {
      return selectPersistentFilterConditionField(state, directField);
    }
    if (key.upArrow === true) {
      return movePersistentFilterConditionCursor(state, -1);
    }
    if (key.downArrow === true) {
      return movePersistentFilterConditionCursor(state, 1);
    }
    if (isReturnKey(key)) {
      const field = DASHBOARD_FILTER_CONDITION_FIELDS[editor.cursor];
      return field === undefined ? state : selectPersistentFilterConditionField(state, field);
    }
    return state;
  }

  if (key.leftArrow === true) {
    return backPersistentFilterConditionEditor(state);
  }
  if (key.upArrow === true) {
    return movePersistentFilterConditionCursor(state, -1);
  }
  if (key.downArrow === true) {
    return movePersistentFilterConditionCursor(state, 1);
  }
  if (key.input === " ") {
    const option = editor.options[editor.cursor];
    return option === undefined
      ? state
      : togglePersistentFilterConditionValue(state, editor.field, option.id);
  }
  const slotIndex = editor.options.findIndex(
    (_option, index) => dashboardFilterConditionSlot(index) === key.input,
  );
  if (slotIndex >= 0) {
    const option = editor.options[slotIndex];
    return option === undefined
      ? state
      : togglePersistentFilterConditionValue(state, editor.field, option.id);
  }
  return isReturnKey(key) ? applyPersistentFilterCondition(state) : state;
}

export function selectPersistentFilterConditionField(
  state: TuiState,
  field: DashboardFilterConditionField,
): TuiState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor?.stage !== "field") {
    return state;
  }
  const options = selectDashboardFilterConditionOptions(
    state.snapshot,
    state,
    state.screen.draftConditions,
  )[field];
  const selectedIds =
    state.screen.draftConditions
      .find((condition) => condition.field === field)
      ?.values.map((value) => value.id) ?? [];
  const selectedCursor = options.findIndex((option) => selectedIds.includes(option.id));
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: {
        stage: "values",
        field,
        cursor: Math.max(0, selectedCursor),
        options,
        selectedIds,
      },
    },
  };
}

export function togglePersistentFilterConditionValue(
  state: TuiState,
  field: DashboardFilterConditionField,
  valueId: string,
): TuiState {
  if (
    state.screen.name !== "persistentFilter" ||
    state.screen.conditionEditor?.stage !== "values" ||
    state.screen.conditionEditor.field !== field
  ) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  const optionIndex = editor.options.findIndex((option) => option.id === valueId);
  if (optionIndex < 0) return state;
  const selected = new Set(editor.selectedIds);
  if (selected.has(valueId)) selected.delete(valueId);
  else selected.add(valueId);
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: {
        ...editor,
        cursor: optionIndex,
        selectedIds: editor.options.flatMap((option) =>
          selected.has(option.id) ? [option.id] : [],
        ),
      },
    },
  };
}

export function backPersistentFilterConditionEditor(state: TuiState): TuiState {
  if (
    state.screen.name !== "persistentFilter" ||
    state.screen.conditionEditor?.stage !== "values"
  ) {
    return state;
  }
  const fieldCursor = DASHBOARD_FILTER_CONDITION_FIELDS.indexOf(state.screen.conditionEditor.field);
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: { stage: "field", cursor: Math.max(0, fieldCursor) },
    },
  };
}

export function applyPersistentFilterCondition(state: TuiState): TuiState {
  if (
    state.screen.name !== "persistentFilter" ||
    state.screen.conditionEditor?.stage !== "values"
  ) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  const retained = state.screen.draftConditions.filter(
    (condition) => condition.field !== editor.field,
  );
  const condition = conditionFromEditor(editor.field, editor.options, editor.selectedIds);
  const draftConditions = normalizeDashboardFilterConditions(
    condition === undefined ? retained : [...retained, condition],
  );
  const { conditionEditor: _closed, ...screen } = state.screen;
  return { ...state, screen: { ...screen, draftConditions } };
}

export function cancelPersistentFilterConditionEditor(state: TuiState): TuiState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  const { conditionEditor: _closed, ...screen } = state.screen;
  return { ...state, screen };
}

function movePersistentFilterConditionCursor(state: TuiState, delta: -1 | 1): TuiState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  const length =
    editor.stage === "field" ? DASHBOARD_FILTER_CONDITION_FIELDS.length : editor.options.length;
  if (length === 0) return state;
  const cursor = Math.min(length - 1, Math.max(0, editor.cursor + delta));
  if (cursor === editor.cursor) return state;
  return {
    ...state,
    screen: { ...state.screen, conditionEditor: { ...editor, cursor } },
  };
}

function conditionFieldForKey(input: string): DashboardFilterConditionField | undefined {
  switch (input.toUpperCase()) {
    case "S":
      return "status";
    case "P":
      return "project";
    case "A":
      return "agent";
    default:
      return undefined;
  }
}

function conditionFromEditor(
  field: DashboardFilterConditionField,
  options: readonly DashboardFilterConditionOption[],
  selectedIds: readonly string[],
): DashboardFilterCondition | undefined {
  const selected = new Set(selectedIds);
  const values = options.filter((option) => selected.has(option.id));
  if (values.length === 0) return undefined;
  switch (field) {
    case "status":
      return {
        field,
        values: values.map((value) => ({ id: value.id as AgentState, label: value.label })),
      };
    case "project":
      return {
        field,
        values: values.map((value) => ({ id: value.id as ProjectId, label: value.label })),
      };
    case "agent":
      return {
        field,
        values: values.map((value) => ({ id: value.id as ProviderId, label: value.label })),
      };
  }
}
