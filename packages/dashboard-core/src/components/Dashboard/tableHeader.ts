import type { DashboardPersistentFilterProjection } from "../../selectors/dashboardPersistentFilter.js";
import type { DashboardSessionOverflow } from "../../selectors/dashboardViewport.js";
import { cellWidth, type RowGridLayout, truncateCells } from "../WorktreeRow/layout.js";
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
  | "spacer"
  | "count";

export type DashboardFilterHeaderSegment = {
  text: string;
  role: DashboardFilterHeaderSegmentRole;
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
  | { kind: "aboveOverflow"; overflow: DashboardSessionOverflow }
  | { kind: "empty" };

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
}): DashboardTableHeaderModel {
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
  return { kind: "empty" };
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
  const contentColumns = persistentFilterContentColumns(columns);
  const prefix = persistentFilterEditorPrefix(contentColumns);
  const count = persistentFilterCount(projection, overflow, columns < 32);
  const countWidth = cellWidth(count);
  const prefixWidth = textLineSegmentsWidth(prefix);
  const countGap = contentColumns >= prefixWidth + countWidth + 3 ? 2 : 0;
  const queryWidth = Math.max(
    1,
    contentColumns - prefixWidth - (countGap > 0 ? countWidth + countGap : 0),
  );
  const draft = projection.draft ?? { value: projection.query, cursor: projection.query.length };
  const content = [
    ...prefix,
    ...persistentFilterEditorWindow(draft.value, draft.cursor, queryWidth),
  ];
  const segments =
    countGap > 0 ? appendPersistentFilterCount(content, count, contentColumns, countGap) : content;
  return {
    kind: "editing",
    segments: padPersistentFilterHeader(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function appliedPersistentFilterHeader(
  columns: number,
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
): DashboardFilterHeaderModel {
  const contentColumns = persistentFilterContentColumns(columns);
  const prefix: DashboardFilterHeaderSegment[] = [
    { text: contentColumns >= 16 ? "FILTER " : "F ", role: "label" },
  ];
  const count = persistentFilterCount(projection, overflow, columns < 32);
  const countWidth = cellWidth(count);
  const prefixWidth = textLineSegmentsWidth(prefix);
  const showCount = contentColumns >= prefixWidth + countWidth + 3;
  const summaryWidth = Math.max(0, contentColumns - prefixWidth - (showCount ? countWidth + 2 : 0));
  const content: DashboardFilterHeaderSegment[] = [
    ...prefix,
    { text: truncateCells(projection.query, summaryWidth), role: "query" },
  ];
  const segments = showCount
    ? appendPersistentFilterCount(content, count, contentColumns, 2)
    : content;
  return {
    kind: "applied",
    segments: padPersistentFilterHeader(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function persistentFilterContentColumns(columns: number): number {
  return columns >= 3 ? columns - 2 : columns;
}

function padPersistentFilterHeader(
  segments: readonly DashboardFilterHeaderSegment[],
  columns: number,
): DashboardFilterHeaderSegment[] {
  if (columns < 3) {
    return clipTextLineSegments(segments, columns);
  }
  return [
    { text: " ", role: "spacer" },
    ...clipTextLineSegments(segments, columns - 2),
    { text: " ", role: "spacer" },
  ];
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
