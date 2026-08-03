import {
  DASHBOARD_FILTER_CONDITION_FIELDS,
  dashboardFilterConditionFieldLabel,
  dashboardFilterConditionSlot,
} from "../../selectors/dashboardFilterConditions.js";
import type {
  DashboardFilterConditionEditor,
  DashboardFilterConditionField,
  TuiScreen,
} from "../../state/types.js";
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";

export type DashboardFilterConditionPanelRow =
  | {
      kind: "field";
      id: string;
      marker: "▸" | " ";
      key: string;
      label: string;
      summary: string;
      selectionCount: number;
      field: DashboardFilterConditionField;
    }
  | {
      kind: "value";
      id: string;
      marker: "▸" | " ";
      key: string;
      label: string;
      checked: boolean;
      field: DashboardFilterConditionField;
      valueId: string;
    };

export type DashboardFilterConditionPanelAction = {
  id: "back" | "apply";
  label: "←" | "✓";
};

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

/** Builds a bounded, cursor-windowed panel without changing dashboard viewport row math. */
export function dashboardFilterConditionPanelModel({
  screen,
  columns,
  availableRows,
}: {
  screen: Extract<TuiScreen, { name: "persistentFilter" }>;
  columns: number;
  availableRows: number;
}): DashboardFilterConditionPanelModel | undefined {
  const editor = screen.conditionEditor;
  if (editor === undefined) return undefined;
  const actions: readonly DashboardFilterConditionPanelAction[] =
    editor.stage === "values"
      ? [
          { id: "back", label: "←" },
          { id: "apply", label: "✓" },
        ]
      : [];
  const actionRows = actions.length === 0 ? 0 : 1;
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
  return {
    stage: editor.stage,
    title:
      editor.stage === "field"
        ? "ADD CONDITION"
        : `${dashboardFilterConditionFieldLabel(editor.field).toUpperCase()} CONDITION`,
    width,
    height: Math.max(1, visibleRows.length) + 3 + actionRows,
    rows: visibleRows.map((row) => ({
      ...row,
      label: truncateCells(row.label, Math.max(1, width - 10)),
    })),
    actions,
    ...(visibleRows.length === 0 ? { emptyMessage: "No values available" } : {}),
    hiddenAbove,
    hiddenBelow,
  };
}

function conditionPanelRows(
  screen: Extract<TuiScreen, { name: "persistentFilter" }>,
  editor: DashboardFilterConditionEditor,
): DashboardFilterConditionPanelRow[] {
  if (editor.stage === "field") {
    return DASHBOARD_FILTER_CONDITION_FIELDS.map((field, index) => {
      const condition = screen.draftConditions.find((candidate) => candidate.field === field);
      return {
        kind: "field",
        id: `field:${field}`,
        marker: index === editor.cursor ? "▸" : " ",
        key: fieldKey(field),
        label: dashboardFilterConditionFieldLabel(field),
        summary: conditionSelectionSummary(condition?.values ?? []),
        selectionCount: condition?.values.length ?? 0,
        field,
      };
    });
  }
  return editor.options.map((option, index) => ({
    kind: "value",
    id: `value:${editor.field}:${option.id}`,
    marker: index === editor.cursor ? "▸" : " ",
    key: dashboardFilterConditionSlot(index) ?? " ",
    label: option.label,
    checked: editor.selectedIds.includes(option.id),
    field: editor.field,
    valueId: option.id,
  }));
}

function conditionSelectionSummary(values: readonly { label: string }[]): string {
  const first = values[0];
  if (first === undefined) return "Any";
  if (values.length === 1) return first.label;
  return `${first.label} +${values.length - 1}`;
}

function fieldKey(field: DashboardFilterConditionField): string {
  switch (field) {
    case "status":
      return "S";
    case "project":
      return "P";
    case "agent":
      return "A";
    default:
      return assertNeverConditionField(field);
  }
}

function assertNeverConditionField(field: never): never {
  throw new Error(`Unhandled dashboard filter condition field: ${field}`);
}

function windowStart(cursor: number, itemCount: number, rowBudget: number): number {
  if (itemCount <= rowBudget) return 0;
  const centered = cursor - Math.floor(rowBudget / 2);
  return Math.min(itemCount - rowBudget, Math.max(0, centered));
}
