// Geometry and sizing math for the station button (no React, no colors).

import type { ProjectRollupEntry, StationButtonStatus } from "./status.js";

// Terminal glyph form of the black vector mark in station/assets/station-icon.svg.
export const STATION_ICON = "⧉";
export const ATTENTION_MARK = "!";

// The glyph measures as 1 cell but the font paints it ~2 wide, so reserve a
// fixed slot rather than trust the measured width (else neighbors/borders overlap).
export const ICON_COLS = 2;
export const ICON_PAD = 1;

// Collapsed base centers the icon at rest; it glides to the top-left (its
// expanded spot) as the card opens. Attention keeps the icon top-left + "!".
export const COLLAPSED_BASE_COLS = ICON_COLS + 2 * ICON_PAD + 2; // icon + pad each side + border = 6
const COLLAPSED_BASE_ROWS = 3;
// Framed alert: a "!" border around the centered icon.
export const COLLAPSED_ATTENTION_COLS = 1 + 1 + ICON_COLS + 1 + 1 + 2; // ! pad icon pad ! + border = 8
const COLLAPSED_ATTENTION_ROWS = 5; // ! / icon / ! + border

const EXPANDED_BORDER_ROWS = 2;
const EXPANDED_BOTTOM_PAD_ROWS = 1;
const EXPANDED_BASE_ROWS = EXPANDED_BORDER_ROWS + 1 + 2 + EXPANDED_BOTTOM_PAD_ROWS;
const EXPANDED_ATTENTION_ROWS = EXPANDED_BORDER_ROWS + 1 + 1 + 2 + EXPANDED_BOTTOM_PAD_ROWS;
const EXPANDED_RIGHT_PAD = 3;
export const CONTENT_INDENT = ICON_COLS + 1; // body clears the corner icon
const ATTENTION_SINGLE_LINE = "needs your attention";
const ATTENTION_HINT_LINE = "↵ or click to focus";
// Width budget only; the painted first line comes from attentionLines (queue-aware).
const ATTENTION_LINES = [ATTENTION_SINGLE_LINE, ATTENTION_HINT_LINE] as const;
// Stable count (2 digits, plural) so card width doesn't resize under cursor on count changes.
const STABLE_SUMMARY_COUNT = 88;
// Fixed name budget so a live session-name change can't resize this top-right-anchored card out
// from under a hovering cursor (painted name is truncated to match — clampSessionName).
const STABLE_NAME_COLS = 20;
// Counts and queue depths paint at most two digits so no live tick can outgrow
// the stable width budgets.
const MAX_PAINTED_COUNT = 99;
/** Per-project roll-up lines before the card folds the rest into "+N more". */
export const ROLLUP_MAX_LINES = 5;
const ROLLUP_GLYPH_COLS = 2; // status glyph + space before the project name
const CELEBRATION_TITLE_COLS = 28;

// Above the panes and the centered STATION popup (z30); below the app toast (z100).
export const STATION_BUTTON_Z_INDEX = 50;

export const ANIM_MS = 150;
export const FRAME_MS = 10;
export const GRADIENT_EDGE = 4; // chars of soft fade at the text's revealing front

export type Dims = { width: number; height: number };

export type IslandCelebration = { prNumber: number; title?: string | undefined };

export type IslandDisplayInput = {
  status: StationButtonStatus;
  /** C3 opt-in: the collapsed rest state paints fleet counts, not the bare mark. */
  restCounts?: boolean | undefined;
  celebration?: IslandCelebration | undefined;
};

/** What the island paints; one value drives both the content and targetDims. */
export type IslandDisplay =
  | { kind: "mark" }
  | { kind: "alertMark" }
  | { kind: "counts"; working: number; ready: number; idle: number }
  | { kind: "celebration"; celebration: IslandCelebration }
  | { kind: "alertCard"; sessionName: string; needsYouCount: number }
  | { kind: "rollup"; entries: readonly ProjectRollupEntry[] }
  | { kind: "summary"; working: number; idle: number };

/** The island's single display-priority ladder, per hover state. */
export function islandDisplay(input: IslandDisplayInput, expanded: boolean): IslandDisplay {
  const status = input.status;
  if (expanded) {
    if (status.attention) {
      return {
        kind: "alertCard",
        sessionName: status.sessionName ?? "session",
        needsYouCount: status.needsYouCount,
      };
    }
    if (status.projectRollup !== undefined && status.projectRollup.length > 0) {
      return { kind: "rollup", entries: status.projectRollup };
    }
    return {
      kind: "summary",
      working: status.workingCount,
      // Ready sessions read as idle in the totals (the fleet breakdown keeps them disjoint).
      idle: status.readyCount + status.idleCount,
    };
  }
  if (status.attention) {
    return { kind: "alertMark" };
  }
  if (input.celebration !== undefined) {
    return { kind: "celebration", celebration: input.celebration };
  }
  if (input.restCounts === true) {
    return {
      kind: "counts",
      working: status.workingCount,
      ready: status.readyCount,
      idle: status.idleCount,
    };
  }
  return { kind: "mark" };
}

export function sessionSummary(count: number, verb: string): string {
  return `${count} session${count === 1 ? "" : "s"} ${verb}`;
}

export function paintedCount(count: number): number {
  return Math.min(count, MAX_PAINTED_COUNT);
}

/** The attention card's message lines; the first swaps to the queue when several ask. */
export function attentionLines(needsYouCount: number): readonly [string, string] {
  const first =
    needsYouCount > 1 ? `! ${paintedCount(needsYouCount)} need you ›` : ATTENTION_SINGLE_LINE;
  return [first, ATTENTION_HINT_LINE];
}

export function celebrationText(celebration: IslandCelebration): string {
  const base = `✓ #${celebration.prNumber} merged`;
  const title = celebration.title?.trim();
  if (title === undefined || title.length === 0) {
    return base;
  }
  const clamped =
    title.length <= CELEBRATION_TITLE_COLS
      ? title
      : `${title.slice(0, CELEBRATION_TITLE_COLS - 1)}…`;
  return `${base} · ${clamped}`;
}

/** Painted roll-up rows: the first ROLLUP_MAX_LINES entries, plus one "+N more" fold. */
function rollupLineCount(entryCount: number): number {
  return entryCount <= ROLLUP_MAX_LINES ? entryCount : ROLLUP_MAX_LINES + 1;
}

// Truncate the attention card's session name to the reserved column budget so
// the painted name never exceeds the (stabilized) card width.
export function clampSessionName(name: string): string {
  return name.length <= STABLE_NAME_COLS ? name : `${name.slice(0, STABLE_NAME_COLS - 1)}…`;
}

export function targetDims(display: IslandDisplay): Dims {
  switch (display.kind) {
    case "mark":
      return { width: COLLAPSED_BASE_COLS, height: COLLAPSED_BASE_ROWS };
    case "alertMark":
      return { width: COLLAPSED_ATTENTION_COLS, height: COLLAPSED_ATTENTION_ROWS };
    case "counts":
      return { width: COLLAPSED_COUNTS_COLS, height: COLLAPSED_BASE_ROWS };
    case "celebration": {
      const interior = ICON_COLS + 1 + celebrationText(display.celebration).length;
      return { width: interior + 2 * ICON_PAD + 2, height: COLLAPSED_BASE_ROWS };
    }
    case "alertCard": {
      // Clamp the name's contribution so the card width never tracks the live
      // session name (the painted name is truncated to match — clampSessionName).
      const nameCols = Math.min(display.sessionName.length, STABLE_NAME_COLS);
      const iconRow = ICON_COLS + 1 + nameCols;
      const body = CONTENT_INDENT + longest(ATTENTION_LINES);
      return {
        width: Math.max(iconRow, body) + EXPANDED_RIGHT_PAD + 2,
        height: EXPANDED_ATTENTION_ROWS,
      };
    }
    case "rollup":
      // Fixed name budget (names clamp to match), so renames/new projects only
      // ever change the card's height, never its width.
      return {
        width: CONTENT_INDENT + ROLLUP_GLYPH_COLS + STABLE_NAME_COLS + EXPANDED_RIGHT_PAD + 2,
        height:
          EXPANDED_BORDER_ROWS + 1 + rollupLineCount(display.entries.length) + EXPANDED_BOTTOM_PAD_ROWS,
      };
    case "summary": {
      // Measure with a stable count, not the live values: the card is anchored top-right, so a width
      // change on a count tick slides it out from under a stationary cursor and reads as a hover leave.
      const body =
        CONTENT_INDENT + Math.max(summaryColumns("working"), summaryColumns("idle"));
      return {
        width: Math.max(ICON_COLS, body) + EXPANDED_RIGHT_PAD + 2,
        height: EXPANDED_BASE_ROWS,
      };
    }
  }
}

// The collapsed counts row measures with 2-digit lanes (`⠿88 ●88 ○88`) so live
// count ticks can't slide the box out from under an approaching cursor.
const STABLE_COUNT_LANES_COLS = 3 * (1 + 2) + 2;
export const COLLAPSED_COUNTS_COLS =
  ICON_COLS + 1 + STABLE_COUNT_LANES_COLS + 2 * ICON_PAD + 2;

function summaryColumns(verb: string): number {
  return sessionSummary(STABLE_SUMMARY_COUNT, verb).length;
}

function longest(lines: readonly string[]): number {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Smooth acceleration and deceleration — gentler at both ends than ease-out.
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}
