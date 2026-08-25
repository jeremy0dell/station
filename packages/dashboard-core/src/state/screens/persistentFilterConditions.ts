import {
  DASHBOARD_FILTER_CONDITION_FIELDS,
  dashboardFilterConditionFieldForKey,
  dashboardFilterConditionSlot,
  dashboardFilterConditionsWithSelection,
  selectDashboardFilterConditionOptions,
} from "../../selectors/dashboardFilterConditions.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { DashboardFilterConditionField, DashboardState } from "../types.js";

export function openPersistentFilterConditionEditor(state: DashboardState): DashboardState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor !== undefined) {
    return state;
  }
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: {
        stage: "field",
        focusedItemId: DASHBOARD_FILTER_CONDITION_FIELDS[0] ?? "applyFilter",
      },
    },
  };
}

export function handlePersistentFilterConditionKey(
  state: DashboardState,
  key: TuiKey,
): DashboardState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  if (key.escape === true) {
    return cancelPersistentFilterConditionEditor(state);
  }
  const editor = state.screen.conditionEditor;
  if (editor.stage === "field") {
    const directField = dashboardFilterConditionFieldForKey(key.input);
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
      return editor.focusedItemId === "applyFilter"
        ? state
        : selectPersistentFilterConditionField(state, editor.focusedItemId);
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
    const option = editor.options.find((candidate) => candidate.id === editor.focusedValueId);
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
  return isReturnKey(key) ? donePersistentFilterConditionEditor(state) : state;
}

export function selectPersistentFilterConditionField(
  state: DashboardState,
  field: DashboardFilterConditionField,
): DashboardState {
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
  const focusedValueId =
    options.find((option) => selectedIds.includes(option.id))?.id ?? options[0]?.id;
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: {
        stage: "values",
        field,
        ...(focusedValueId === undefined ? {} : { focusedValueId }),
        options,
        selectedIds,
      },
    },
  };
}

export function togglePersistentFilterConditionValue(
  state: DashboardState,
  field: DashboardFilterConditionField,
  valueId: string,
): DashboardState {
  if (
    state.screen.name !== "persistentFilter" ||
    state.screen.conditionEditor?.stage !== "values" ||
    state.screen.conditionEditor.field !== field
  ) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  if (!editor.options.some((option) => option.id === valueId)) return state;
  const selected = new Set(editor.selectedIds);
  if (selected.has(valueId)) selected.delete(valueId);
  else selected.add(valueId);
  return {
    ...state,
    screen: {
      ...state.screen,
      conditionEditor: {
        ...editor,
        focusedValueId: valueId,
        selectedIds: editor.options.flatMap((option) =>
          selected.has(option.id) ? [option.id] : [],
        ),
      },
    },
  };
}

export function backPersistentFilterConditionEditor(state: DashboardState): DashboardState {
  return retainPersistentFilterConditionEditor(state);
}

export function donePersistentFilterConditionEditor(state: DashboardState): DashboardState {
  return retainPersistentFilterConditionEditor(state);
}

export function cancelPersistentFilterConditionEditor(state: DashboardState): DashboardState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  const { conditionEditor: _closed, ...screen } = state.screen;
  return { ...state, screen };
}

function movePersistentFilterConditionCursor(state: DashboardState, delta: -1 | 1): DashboardState {
  if (state.screen.name !== "persistentFilter" || state.screen.conditionEditor === undefined) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  if (editor.stage === "field") {
    const itemIds: readonly (DashboardFilterConditionField | "applyFilter")[] = [
      ...DASHBOARD_FILTER_CONDITION_FIELDS,
      "applyFilter",
    ];
    const current = Math.max(0, itemIds.indexOf(editor.focusedItemId));
    const focusedItemId = itemIds[Math.min(itemIds.length - 1, Math.max(0, current + delta))];
    if (focusedItemId === undefined || focusedItemId === editor.focusedItemId) return state;
    return {
      ...state,
      screen: { ...state.screen, conditionEditor: { ...editor, focusedItemId } },
    };
  }
  if (editor.options.length === 0) return state;
  const current = Math.max(
    0,
    editor.options.findIndex((option) => option.id === editor.focusedValueId),
  );
  const focusedValueId =
    editor.options[Math.min(editor.options.length - 1, Math.max(0, current + delta))]?.id;
  if (focusedValueId === undefined || focusedValueId === editor.focusedValueId) return state;
  return {
    ...state,
    screen: { ...state.screen, conditionEditor: { ...editor, focusedValueId } },
  };
}

function retainPersistentFilterConditionEditor(state: DashboardState): DashboardState {
  if (
    state.screen.name !== "persistentFilter" ||
    state.screen.conditionEditor?.stage !== "values"
  ) {
    return state;
  }
  const editor = state.screen.conditionEditor;
  const draftConditions = dashboardFilterConditionsWithSelection(
    state.screen.draftConditions,
    editor.field,
    editor.options,
    editor.selectedIds,
  );
  return {
    ...state,
    screen: {
      ...state.screen,
      draftConditions,
      conditionEditor: { stage: "field", focusedItemId: editor.field },
    },
  };
}
