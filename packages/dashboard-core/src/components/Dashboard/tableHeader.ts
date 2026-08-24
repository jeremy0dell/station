import type { DashboardPersistentFilterProjection } from "../../selectors/dashboardPersistentFilter.js";
import type { DashboardSessionOverflow } from "../../selectors/dashboardSlots.js";
import type { DashboardFilterConditionField } from "../../state/types.js";
import { cellWidth, type RowGridLayout } from "../WorktreeRow/layout.js";
import {
  clipTextLineSegments,
  normalizeTextLineWidth,
  textLineSegmentsWidth,
} from "./segmentLayout.js";

export type DashboardFilterHeaderSegmentRole =
  | "rail"
  | "label"
  | "slash"
  | "query"
  | "caret"
  | "conditionSeparator"
  | "conditionField"
  | "conditionOperator"
  | "conditionValue"
  | "spacer"
  | "count";

export type DashboardFilterHeaderSegment = {
  text: string;
  role: DashboardFilterHeaderSegmentRole;
  field?: DashboardFilterConditionField;
  valueId?: string;
};

/** A persistent filter rendered in the dashboard table-header slot. */
export type DashboardFilterHeaderModel = {
  kind: "editing" | "applied";
  segments: readonly DashboardFilterHeaderSegment[];
  zeroMatches: boolean;
};

export type DashboardTableHeaderModel =
  | { kind: "persistentFilter"; filter: DashboardFilterHeaderModel }
  | { kind: "columns"; layout: RowGridLayout }
  | { kind: "aboveOverflow"; overflow: DashboardSessionOverflow };

export function dashboardTableHeaderModel({
  layout,
  overflow,
  columns = 80,
  persistentFilter,
}: {
  layout: RowGridLayout | undefined;
  overflow: DashboardSessionOverflow;
  columns?: number;
  persistentFilter?: DashboardPersistentFilterProjection;
}): DashboardTableHeaderModel | undefined {
  if (persistentFilter !== undefined) {
    return {
      kind: "persistentFilter",
      filter: dashboardPersistentFilterHeaderModel({
        columns,
        projection: persistentFilter,
        overflow,
      }),
    };
  }
  // The position cue owns the shared row whenever sessions are hidden above.
  if (overflow.above > 0) {
    return { kind: "aboveOverflow", overflow };
  }
  if (layout !== undefined) {
    return { kind: "columns", layout };
  }
  return undefined;
}

export function dashboardPersistentFilterHeaderModel({
  columns,
  projection,
  overflow,
}: {
  columns: number;
  projection: DashboardPersistentFilterProjection;
  overflow: DashboardSessionOverflow;
}): DashboardFilterHeaderModel {
  const width = normalizeTextLineWidth(columns);
  return projection.source === "draft"
    ? editingPersistentFilterHeader(width, projection, overflow)
    : appliedPersistentFilterHeader(width, projection, overflow);
}

function editingPersistentFilterHeader(
  columns: number,
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
): DashboardFilterHeaderModel {
  const prefix = persistentFilterEditorPrefix(columns);
  const count = persistentFilterCount(projection, overflow, columns < 32);
  const countWidth = cellWidth(count);
  const prefixWidth = textLineSegmentsWidth(prefix);
  const countGap = columns >= prefixWidth + countWidth + 3 ? 2 : 0;
  const summaryWidth = Math.max(
    1,
    columns - prefixWidth - (countGap > 0 ? countWidth + countGap : 0),
  );
  const conditionSegments = persistentFilterConditionSummary(projection);
  const conditionWidth = textLineSegmentsWidth(conditionSegments);
  const reservedConditionWidth = Math.min(conditionWidth, Math.floor(summaryWidth / 2));
  const queryWidth = Math.max(1, summaryWidth - reservedConditionWidth);
  const draft = projection.draft ?? { value: projection.query, cursor: projection.query.length };
  const content = [
    ...prefix,
    ...persistentFilterEditorWindow(draft.value, draft.cursor, queryWidth),
    ...conditionSegments,
  ];
  const segments =
    countGap > 0 ? appendPersistentFilterCount(content, count, columns, countGap) : content;
  return {
    kind: "editing",
    segments: clipTextLineSegments(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function appliedPersistentFilterHeader(
  columns: number,
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
): DashboardFilterHeaderModel {
  const prefix: DashboardFilterHeaderSegment[] = [
    { text: columns >= 16 ? "FILTER " : "F ", role: "label" },
  ];
  const count = persistentFilterCount(projection, overflow, columns < 32);
  const countWidth = cellWidth(count);
  const prefixWidth = textLineSegmentsWidth(prefix);
  const showCount = columns >= prefixWidth + countWidth + 3;
  const summaryWidth = Math.max(0, columns - prefixWidth - (showCount ? countWidth + 2 : 0));
  const summary = persistentFilterSummary(projection);
  const content: DashboardFilterHeaderSegment[] = [
    ...prefix,
    ...clipTextLineSegments(summary, summaryWidth),
  ];
  const segments = showCount ? appendPersistentFilterCount(content, count, columns, 2) : content;
  return {
    kind: "applied",
    segments: clipTextLineSegments(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function persistentFilterSummary(
  projection: DashboardPersistentFilterProjection,
): DashboardFilterHeaderSegment[] {
  return projection.summarySegments.map((segment) => {
    const built: DashboardFilterHeaderSegment = {
      text: segment.text,
      role: dashboardFilterHeaderRole(segment.role),
    };
    if (segment.field !== undefined) built.field = segment.field;
    if (segment.valueId !== undefined) built.valueId = segment.valueId;
    return built;
  });
}

function dashboardFilterHeaderRole(
  role: DashboardPersistentFilterProjection["summarySegments"][number]["role"],
): DashboardFilterHeaderSegmentRole {
  switch (role) {
    case "text":
      return "query";
    case "separator":
      return "conditionSeparator";
    case "field":
      return "conditionField";
    case "operator":
      return "conditionOperator";
    case "value":
      return "conditionValue";
  }
}

function persistentFilterConditionSummary(
  projection: DashboardPersistentFilterProjection,
): DashboardFilterHeaderSegment[] {
  const segments = persistentFilterSummary(projection).filter(
    (segment) => segment.role !== "query",
  );
  if (segments.length > 0 && segments[0]?.role !== "conditionSeparator") {
    return [{ text: " ", role: "spacer" }, ...segments];
  }
  return segments;
}

function persistentFilterEditorPrefix(columns: number): DashboardFilterHeaderSegment[] {
  if (columns < 12) {
    return [
      { text: "▏", role: "rail" },
      { text: "F", role: "label" },
      { text: "/", role: "slash" },
    ];
  }
  return [
    { text: "▏", role: "rail" },
    { text: " ", role: "spacer" },
    { text: "FILTER", role: "label" },
    { text: " ", role: "spacer" },
    { text: "/", role: "slash" },
  ];
}

function persistentFilterEditorWindow(
  value: string,
  cursor: number,
  columns: number,
): DashboardFilterHeaderSegment[] {
  const sanitized = value.replace(/[\t\n\r]+/g, " ");
  const boundedCursor = Math.min(Math.max(0, cursor), sanitized.length);
  const before = sanitized.slice(0, boundedCursor);
  const after = sanitized.slice(boundedCursor);
  const contentBudget = Math.max(0, columns - 1);
  const visibleBefore = suffixCells(before, contentBudget);
  const remaining = Math.max(0, contentBudget - cellWidth(visibleBefore));
  const visibleAfter = prefixCells(after, remaining);
  return [
    { text: visibleBefore, role: "query" },
    { text: "▏", role: "caret" },
    { text: visibleAfter, role: "query" },
  ];
}

function persistentFilterCount(
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
  compact: boolean,
): string {
  let count = `${projection.matchCount}/${projection.totalCount}`;
  if (!compact) {
    const matchLabel = projection.matchCount === 1 ? "match" : "matches";
    count = `${count} ${matchLabel}`;
  }
  return overflow.above > 0 ? `↑${overflow.above} · ${count}` : count;
}

function appendPersistentFilterCount(
  segments: readonly DashboardFilterHeaderSegment[],
  count: string,
  columns: number,
  minimumGap: number,
): DashboardFilterHeaderSegment[] {
  const spacer = Math.max(minimumGap, columns - textLineSegmentsWidth(segments) - cellWidth(count));
  return [
    ...segments,
    { text: " ".repeat(spacer), role: "spacer" },
    { text: count, role: "count" },
  ];
}

function suffixCells(value: string, cells: number): string {
  const units = graphemes(value);
  let result = "";
  let width = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index] ?? "";
    const unitWidth = cellWidth(unit);
    if (width + unitWidth > cells) {
      break;
    }
    result = `${unit}${result}`;
    width += unitWidth;
  }
  return result;
}

function prefixCells(value: string, cells: number): string {
  let result = "";
  let width = 0;
  for (const unit of graphemes(value)) {
    const unitWidth = cellWidth(unit);
    if (width + unitWidth > cells) {
      break;
    }
    result += unit;
    width += unitWidth;
  }
  return result;
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter !== "function") {
    return Array.from(value);
  }
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (segment) => segment.segment,
  );
}
