// Geometry and sizing math for the station button (no React, no colors).

export const STATION_ICON = "⧉";
export const ATTENTION_MARK = "!";

// The glyph measures as 1 cell but the font paints it ~2 wide, so reserve a
// fixed slot rather than trust the measured width (else neighbors/borders overlap).
export const ICON_COLS = 2;
const ICON_PAD = 1;

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
export const ATTENTION_LINES = ["needs your attention", "click to focus"] as const;
// Stable count (2 digits, plural) so card width doesn't resize under cursor on count changes.
const STABLE_SUMMARY_COUNT = 88;
// Fixed name budget so a live session-name change can't resize this top-right-anchored card out
// from under a hovering cursor (painted name is truncated to match — clampSessionName).
const STABLE_NAME_COLS = 20;

// Above the panes and the centered STATION popup (z30); below the app toast (z100).
export const STATION_BUTTON_Z_INDEX = 50;

export const ANIM_MS = 150;
export const FRAME_MS = 10;
export const GRADIENT_EDGE = 4; // chars of soft fade at the text's revealing front

export type Dims = { width: number; height: number };

export type ButtonContent = {
  attention: boolean;
  workingCount: number;
  idleCount: number;
  sessionName?: string | undefined;
};

export function sessionSummary(count: number, verb: string): string {
  return `${count} session${count === 1 ? "" : "s"} ${verb}`;
}

// Truncate the attention card's session name to the reserved column budget so
// the painted name never exceeds the (stabilized) card width.
export function clampSessionName(name: string): string {
  return name.length <= STABLE_NAME_COLS ? name : `${name.slice(0, STABLE_NAME_COLS - 1)}…`;
}

export function targetDims(expanded: boolean, content: ButtonContent): Dims {
  const { attention } = content;
  if (!expanded) {
    return attention
      ? { width: COLLAPSED_ATTENTION_COLS, height: COLLAPSED_ATTENTION_ROWS }
      : { width: COLLAPSED_BASE_COLS, height: COLLAPSED_BASE_ROWS };
  }
  return {
    width: expandedInteriorWidth(content) + EXPANDED_RIGHT_PAD + 2,
    height: attention ? EXPANDED_ATTENTION_ROWS : EXPANDED_BASE_ROWS,
  };
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
