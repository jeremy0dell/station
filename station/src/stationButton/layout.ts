// Geometry and sizing math for the station button (no React, no colors).

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

// Above the panes and the centered STATION popup (z30); below the app toast (z100).
export const STATION_BUTTON_Z_INDEX = 50;

export const ANIM_MS = 150;
export const FRAME_MS = 10;
export const GRADIENT_EDGE = 4; // chars of soft fade at the text's revealing front

export type Dims = { width: number; height: number };

export type IslandCelebration = { prNumber: number };

export type ButtonContent = {
  attention: boolean;
  workingCount: number;
  readyCount: number;
  idleCount: number;
  sessionName?: string | undefined;
  /** C3 opt-in: the collapsed rest state paints fleet counts, not the bare mark. */
  restCounts?: boolean | undefined;
  /** C2 opt-in roll-up entries; the count drives the expanded card's height. */
  projectRollup?: readonly unknown[] | undefined;
  celebration?: IslandCelebration | undefined;
};

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
  return `✓ #${celebration.prNumber} merged`;
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

export function targetDims(expanded: boolean, content: ButtonContent): Dims {
  const { attention } = content;
  if (!expanded) {
    if (attention) {
      return { width: COLLAPSED_ATTENTION_COLS, height: COLLAPSED_ATTENTION_ROWS };
    }
    if (content.celebration !== undefined) {
      const interior = ICON_COLS + 1 + celebrationText(content.celebration).length;
      return { width: interior + 2 * ICON_PAD + 2, height: COLLAPSED_BASE_ROWS };
    }
    if (content.restCounts === true) {
      return { width: COLLAPSED_COUNTS_COLS, height: COLLAPSED_BASE_ROWS };
    }
    return { width: COLLAPSED_BASE_COLS, height: COLLAPSED_BASE_ROWS };
  }
  return {
    width: expandedInteriorWidth(content) + EXPANDED_RIGHT_PAD + 2,
    height: expandedRows(content),
  };
}

// The collapsed counts row measures with 2-digit lanes (`⠿88 ●88 ○88`) so live
// count ticks can't slide the box out from under an approaching cursor.
const STABLE_COUNT_LANES_COLS = 3 * (1 + 2) + 2;
export const COLLAPSED_COUNTS_COLS =
  ICON_COLS + 1 + STABLE_COUNT_LANES_COLS + 2 * ICON_PAD + 2;

function expandedRows(content: ButtonContent): number {
  if (content.attention) {
    return EXPANDED_ATTENTION_ROWS;
  }
  const rollupLines = rollupLineCount(content.projectRollup?.length ?? 0);
  if (rollupLines > 0) {
    return EXPANDED_BORDER_ROWS + 1 + rollupLines + EXPANDED_BOTTOM_PAD_ROWS;
  }
  return EXPANDED_BASE_ROWS;
}

// Widest content row inside the card (borders/right pad excluded).
function expandedInteriorWidth(content: ButtonContent): number {
  if (content.attention) {
    // Clamp the name's contribution so the card width never tracks the live
    // session name (the painted name is truncated to match — clampSessionName).
    const nameCols = Math.min((content.sessionName ?? "session").length, STABLE_NAME_COLS);
    const iconRow = ICON_COLS + 1 + nameCols;
    const body = CONTENT_INDENT + longest(ATTENTION_LINES);
    return Math.max(iconRow, body);
  }
  if ((content.projectRollup?.length ?? 0) > 0) {
    // Fixed name budget (names clamp to match), so renames/new projects only
    // ever change the card's height, never its width.
    return CONTENT_INDENT + ROLLUP_GLYPH_COLS + STABLE_NAME_COLS;
  }
  // Measure with a stable count, not the live values: the card is anchored top-right, so a width
  // change on a count tick slides it out from under a stationary cursor and reads as a hover leave.
  const body =
    CONTENT_INDENT +
    Math.max(summaryColumns("working"), summaryColumns("idle"));
  return Math.max(ICON_COLS, body);
}

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
