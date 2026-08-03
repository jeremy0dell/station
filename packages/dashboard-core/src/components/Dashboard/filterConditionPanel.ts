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
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";

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
  width: number;
  height: number;
  rows: readonly DashboardFilterConditionPanelRow[];
  actions: readonly DashboardFilterConditionPanelAction[];
  emptyMessage?: string;
  hiddenAbove: number;
  hiddenBelow: number;
};

export type DashboardFilterConditionPanelOptions = {
  screen: Extract<DashboardScreenView, { name: "persistentFilter" }>;
  columns: number;
  availableRows: number;
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

/** Builds a bounded, cursor-windowed panel without changing dashboard viewport row math. */
export function dashboardFilterConditionPanelModel(
  options: DashboardFilterConditionPanelOptions,
): DashboardFilterConditionPanelModel | undefined {
  const { screen, columns, availableRows } = options;
  const editor = screen.conditionEditor;
  if (editor === undefined) return undefined;

  const actions = conditionPanelActions(editor);
  const actionRows = editor.stage === "field" ? 2 : 1;
  const rowBudget = Math.max(1, Math.min(8, Math.floor(availableRows) - 3 - actionRows));
  const allRows = conditionPanelRows(screen, editor);
  const start = windowStart(editor.cursor, allRows.length, rowBudget);
  const visibleRows = allRows.slice(start, start + rowBudget);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, allRows.length - start - visibleRows.length);
  const maximumLabelWidth = Math.max(0, ...visibleRows.map((row) => cellWidth(row.label)));
  const width = Math.max(
    1,
    Math.min(Math.floor(columns) - 2, Math.max(34, maximumLabelWidth + 12)),
  );
  const rows = truncateConditionPanelRows(visibleRows, width);

  const model: DashboardFilterConditionPanelModel = {
    stage: editor.stage,
    title: conditionPanelTitle(editor),
    width,
    height: Math.max(1, visibleRows.length) + 3 + actionRows,
    rows,
    actions,
    hiddenAbove,
    hiddenBelow,
  };
  if (visibleRows.length === 0) {
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

function truncateConditionPanelRows(
  rows: readonly DashboardFilterConditionPanelRow[],
  width: number,
): DashboardFilterConditionPanelRow[] {
  return rows.map((row) => {
    const truncated: DashboardFilterConditionPanelRow = {
      ...row,
      label: truncateCells(row.label, Math.max(1, width - 10)),
    };
    return truncated;
  });
}

function conditionSelectionSummary(values: readonly { label: string }[]): string {
  const first = values[0];
  if (first === undefined) return "Any";
  if (values.length === 1) return first.label;
  return `${first.label} +${values.length - 1}`;
}

function windowStart(cursor: number, itemCount: number, rowBudget: number): number {
  if (itemCount <= rowBudget) return 0;
  const centered = cursor - Math.floor(rowBudget / 2);
  return Math.min(itemCount - rowBudget, Math.max(0, centered));
}
