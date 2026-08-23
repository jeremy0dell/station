import {
  DASHBOARD_FILTER_CONDITION_FIELDS,
  dashboardFilterConditionFieldKey,
  dashboardFilterConditionFieldLabel,
  dashboardFilterConditionSlot,
} from "../../selectors/dashboardFilterConditions.js";
import type {
  DashboardFilterConditionEditor,
  DashboardFilterConditionField,
  DashboardScreenView,
} from "../../state/types.js";
export type DashboardFilterConditionPanelFieldRow = {
  kind: "field";
  id: string;
  marker: "▸" | " ";
  key: string;
  label: string;
  summary: string;
  selectionCount: number;
  field: DashboardFilterConditionField;
};

export type DashboardFilterConditionPanelValueRow = {
  kind: "value";
  id: string;
  marker: "▸" | " ";
  key: string;
  label: string;
  checked: boolean;
  field: DashboardFilterConditionField;
  valueId: string;
};

export type DashboardFilterConditionPanelRow =
  | DashboardFilterConditionPanelFieldRow
  | DashboardFilterConditionPanelValueRow;

export type DashboardFilterConditionPanelHeaderAction = {
  id: "back" | "close";
  label: "←" | "×";
  placement: "header";
};

export type DashboardFilterConditionPanelFooterAction = {
  id: "done" | "applyFilter";
  label: "Done" | "Apply filter";
  shortcut: "Enter" | "F";
  placement: "footer";
  focused: boolean;
};

export type DashboardFilterConditionPanelAction =
  | DashboardFilterConditionPanelHeaderAction
  | DashboardFilterConditionPanelFooterAction;

export type DashboardFilterConditionPanelModel = {
  stage: "field" | "values";
  title: string;
  rows: readonly DashboardFilterConditionPanelRow[];
  actions: readonly DashboardFilterConditionPanelAction[];
  emptyMessage?: string;
};

export type DashboardFilterConditionPanelOptions = {
  screen: Extract<DashboardScreenView, { name: "persistentFilter" }>;
};

const BACK_ACTION: DashboardFilterConditionPanelHeaderAction = {
  id: "back",
  label: "←",
  placement: "header",
};

const CLOSE_ACTION: DashboardFilterConditionPanelHeaderAction = {
  id: "close",
  label: "×",
  placement: "header",
};

const DONE_ACTION: DashboardFilterConditionPanelFooterAction = {
  id: "done",
  label: "Done",
  shortcut: "Enter",
  placement: "footer",
  focused: false,
};

/** Projects the complete semantic condition editor; the renderer owns clipping and geometry. */
export function dashboardFilterConditionPanelModel(
  options: DashboardFilterConditionPanelOptions,
): DashboardFilterConditionPanelModel | undefined {
  const { screen } = options;
  const editor = screen.conditionEditor;
  if (editor === undefined) return undefined;

  const actions = conditionPanelActions(editor);
  const rows = conditionPanelRows(screen, editor);

  const model: DashboardFilterConditionPanelModel = {
    stage: editor.stage,
    title: conditionPanelTitle(editor),
    rows,
    actions,
  };
  if (rows.length === 0) {
    model.emptyMessage = "No values available";
  }
  return model;
}

function conditionPanelActions(
  editor: DashboardFilterConditionEditor,
): readonly DashboardFilterConditionPanelAction[] {
  if (editor.stage === "values") {
    return [BACK_ACTION, CLOSE_ACTION, DONE_ACTION];
  }

  const applyAction: DashboardFilterConditionPanelFooterAction = {
    id: "applyFilter",
    label: "Apply filter",
    shortcut: "F",
    placement: "footer",
    focused: editor.cursor === DASHBOARD_FILTER_CONDITION_FIELDS.length,
  };
  return [CLOSE_ACTION, applyAction];
}

function conditionPanelTitle(editor: DashboardFilterConditionEditor): string {
  if (editor.stage === "field") {
    return "FILTER CONDITIONS";
  }
  return `${dashboardFilterConditionFieldLabel(editor.field).toUpperCase()} CONDITION`;
}

function conditionPanelRows(
  screen: Extract<DashboardScreenView, { name: "persistentFilter" }>,
  editor: DashboardFilterConditionEditor,
): DashboardFilterConditionPanelRow[] {
  if (editor.stage === "field") {
    return conditionPanelFieldRows(screen, editor);
  }
  return conditionPanelValueRows(editor);
}

function conditionPanelFieldRows(
  screen: Extract<DashboardScreenView, { name: "persistentFilter" }>,
  editor: Extract<DashboardFilterConditionEditor, { stage: "field" }>,
): DashboardFilterConditionPanelFieldRow[] {
  return DASHBOARD_FILTER_CONDITION_FIELDS.map((field, index) => {
    const condition = screen.draftConditions.find((candidate) => candidate.field === field);
    const row: DashboardFilterConditionPanelFieldRow = {
      kind: "field",
      id: `field:${field}`,
      marker: index === editor.cursor ? "▸" : " ",
      key: dashboardFilterConditionFieldKey(field),
      label: dashboardFilterConditionFieldLabel(field),
      summary: conditionSelectionSummary(condition?.values ?? []),
      selectionCount: condition?.values.length ?? 0,
      field,
    };
    return row;
  });
}

function conditionPanelValueRows(
  editor: Extract<DashboardFilterConditionEditor, { stage: "values" }>,
): DashboardFilterConditionPanelValueRow[] {
  return editor.options.map((option, index) => {
    const row: DashboardFilterConditionPanelValueRow = {
      kind: "value",
      id: `value:${editor.field}:${option.id}`,
      marker: index === editor.cursor ? "▸" : " ",
      key: dashboardFilterConditionSlot(index) ?? " ",
      label: option.label,
      checked: editor.selectedIds.includes(option.id),
      field: editor.field,
      valueId: option.id,
    };
    return row;
  });
}

function conditionSelectionSummary(values: readonly { label: string }[]): string {
  const first = values[0];
  if (first === undefined) return "Any";
  if (values.length === 1) return first.label;
  return `${first.label} +${values.length - 1}`;
}
