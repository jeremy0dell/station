import type { DashboardPersistentFilterProjection } from "../../selectors/dashboardPersistentFilter.js";
import type { DashboardSessionOverflow } from "../../selectors/dashboardViewport.js";
import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";

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

export type DashboardFilterHeaderModel = {
  kind: "editing" | "applied";
  segments: readonly DashboardFilterHeaderSegment[];
  zeroMatches: boolean;
};

export type DashboardFilterFooterSegmentRole = "badge" | "key" | "description" | "spacer";

export type DashboardFilterFooterSegment = {
  text: string;
  role: DashboardFilterFooterSegmentRole;
};

export type DashboardPersistentFilterFooterModel =
  | {
      kind: "persistentFilterEditing";
      segments: readonly DashboardFilterFooterSegment[];
    }
  | {
      kind: "persistentFilterApplied";
      text: string;
    };

export function dashboardPersistentFilterHeaderModel({
  columns,
  projection,
  overflow,
}: {
  columns: number;
  projection: DashboardPersistentFilterProjection;
  overflow: DashboardSessionOverflow;
}): DashboardFilterHeaderModel {
  const width = normalizeWidth(columns);
  return projection.source === "draft"
    ? editingHeaderModel(width, projection, overflow)
    : appliedHeaderModel(width, projection, overflow);
}

export function dashboardPersistentFilterEditingFooterModel(
  columns: number,
): Extract<DashboardPersistentFilterFooterModel, { kind: "persistentFilterEditing" }> {
  const width = normalizeWidth(columns);
  const candidates: readonly (readonly DashboardFilterFooterSegment[])[] = [
    footerSegments([
      ["←→", "cursor"],
      ["Enter", "apply"],
      ["Ctrl-U", "clear"],
      ["Esc", "cancel"],
    ]),
    footerSegments([
      ["Enter", "apply"],
      ["^U", "clear"],
      ["Esc", "cancel"],
    ]),
    footerSegments([
      ["↵", "apply"],
      ["Esc", "cancel"],
    ]),
  ];
  const selected = candidates.find((candidate) => filterSegmentsWidth(candidate) <= width);
  return {
    kind: "persistentFilterEditing",
    segments: selected ?? clipFilterSegments(candidates.at(-1) ?? [], width),
  };
}

export function dashboardPersistentFilterAppliedFooterModel(
  text: string,
): Extract<DashboardPersistentFilterFooterModel, { kind: "persistentFilterApplied" }> {
  return { kind: "persistentFilterApplied", text };
}

function editingHeaderModel(
  columns: number,
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
): DashboardFilterHeaderModel {
  const prefix = editorPrefix(columns);
  const status = countText(projection, overflow, columns < 32);
  const statusWidth = cellWidth(status);
  const prefixWidth = filterSegmentsWidth(prefix);
  const statusGap = columns >= prefixWidth + statusWidth + 3 ? 2 : 0;
  const showStatus = statusGap > 0;
  const queryWidth = Math.max(
    1,
    columns - prefixWidth - (showStatus ? statusWidth + statusGap : 0),
  );
  const draft = projection.draft ?? { value: projection.query, cursor: projection.query.length };
  const query = editorWindowSegments(draft.value, draft.cursor, queryWidth);
  const segments: DashboardFilterHeaderSegment[] = [...prefix, ...query];
  if (showStatus) {
    const used = filterSegmentsWidth(segments);
    const spacer = Math.max(statusGap, columns - used - statusWidth);
    segments.push({ text: " ".repeat(spacer), role: "spacer" });
    segments.push({ text: status, role: "count" });
  }
  return {
    kind: "editing",
    segments: clipFilterSegments(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function appliedHeaderModel(
  columns: number,
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
): DashboardFilterHeaderModel {
  const fullPrefix: DashboardFilterHeaderSegment[] = [{ text: "FILTER ", role: "label" }];
  const compactPrefix: DashboardFilterHeaderSegment[] = [{ text: "F ", role: "label" }];
  const prefix = columns >= 16 ? fullPrefix : compactPrefix;
  const status = countText(projection, overflow, columns < 32);
  const prefixWidth = filterSegmentsWidth(prefix);
  const statusWidth = cellWidth(status);
  const showStatus = columns >= prefixWidth + statusWidth + 3;
  const summaryWidth = Math.max(0, columns - prefixWidth - (showStatus ? statusWidth + 2 : 0));
  const segments: DashboardFilterHeaderSegment[] = [
    ...prefix,
    { text: truncateCells(projection.query, summaryWidth), role: "query" },
  ];
  if (showStatus) {
    const spacer = Math.max(2, columns - filterSegmentsWidth(segments) - statusWidth);
    segments.push({ text: " ".repeat(spacer), role: "spacer" });
    segments.push({ text: status, role: "count" });
  }
  return {
    kind: "applied",
    segments: clipFilterSegments(segments, columns),
    zeroMatches: projection.zeroMatches,
  };
}

function editorPrefix(columns: number): DashboardFilterHeaderSegment[] {
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

function editorWindowSegments(
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

function countText(
  projection: DashboardPersistentFilterProjection,
  overflow: DashboardSessionOverflow,
  compact: boolean,
): string {
  const count = compact
    ? `${projection.matchCount}/${projection.totalCount}`
    : `${projection.matchCount}/${projection.totalCount} ${projection.matchCount === 1 ? "match" : "matches"}`;
  return overflow.above > 0 ? `↑${overflow.above} · ${count}` : count;
}

function footerSegments(
  helpers: readonly (readonly [key: string, description: string])[],
): DashboardFilterFooterSegment[] {
  const segments: DashboardFilterFooterSegment[] = [{ text: " FILTER ", role: "badge" }];
  for (const [key, description] of helpers) {
    segments.push({ text: "  ", role: "spacer" });
    segments.push({ text: key, role: "key" });
    segments.push({ text: ` ${description}`, role: "description" });
  }
  return segments;
}

function filterSegmentsWidth(segments: readonly { text: string }[]): number {
  return segments.reduce((total, segment) => total + cellWidth(segment.text), 0);
}

function clipFilterSegments<T extends { text: string }>(
  segments: readonly T[],
  columns: number,
): T[] {
  let remaining = normalizeWidth(columns);
  const clipped: T[] = [];
  for (const segment of segments) {
    if (remaining <= 0) {
      break;
    }
    const text = truncateCells(segment.text, remaining);
    if (text.length > 0) {
      clipped.push({ ...segment, text });
      remaining -= cellWidth(text);
    }
    if (cellWidth(segment.text) > cellWidth(text)) {
      break;
    }
  }
  return clipped;
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

function normalizeWidth(columns: number): number {
  return Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
}
