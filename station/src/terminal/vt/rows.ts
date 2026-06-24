import { TextAttributes } from "@opentui/core";
import type { IBufferCell, Terminal } from "@xterm/headless";
import { rgbToHexColor, stationVtPalette256 } from "./theme.js";

export type VtSpan = {
  text: string;
  /** Display width in cells; differs from text.length around wide chars. */
  width: number;
  fg?: string;
  bg?: string;
  attributes: number;
};

export type VtRow = {
  spans: VtSpan[];
};

export type BuildVisibleRowsOptions = {
  cursorVisible?: boolean;
  palette?: readonly string[];
  /** Lines scrolled up from the live bottom; 0 renders the live viewport. */
  offset?: number;
};

/**
 * Converts the terminal's viewport into rows of style-merged spans. With
 * `offset === 0` this is the live bottom page; a positive offset renders that
 * many lines up into scrollback. The cursor is composited only at the bottom —
 * a live cursor drawn over historical rows would be misleading.
 */
export function buildVisibleRows(
  terminal: Terminal,
  options: BuildVisibleRowsOptions = {},
): VtRow[] {
  const buffer = terminal.buffer.active;
  const palette = options.palette ?? stationVtPalette256;
  // Clamp defensively: callers track scrollback bounds, but reflow can shrink
  // baseY between a scroll and the next paint.
  const offset = Math.max(0, Math.min(options.offset ?? 0, buffer.baseY));
  const startLine = buffer.baseY - offset;
  const cursorVisible = (options.cursorVisible ?? true) && offset === 0;
  const cursorRow = buffer.cursorY;
  // cursorX can equal cols while a wrap is pending (DECAWM deferred wrap);
  // clamp so the cursor cell stays paintable. If the clamped column lands on
  // a wide-char continuation cell (width 0), walk back to the owning cell or
  // the cursor inversion would be invisible.
  let cursorCol = Math.min(buffer.cursorX, terminal.cols - 1);
  const cursorLine = buffer.getLine(buffer.baseY + cursorRow);
  while (cursorCol > 0 && cursorLine?.getCell(cursorCol)?.getWidth() === 0) {
    cursorCol -= 1;
  }
  const workCell = buffer.getNullCell();
  const rows: VtRow[] = [];

  for (let rowIndex = 0; rowIndex < terminal.rows; rowIndex++) {
    const line = buffer.getLine(startLine + rowIndex);
    const spans: VtSpan[] = [];
    let runText = "";
    let runWidth = 0;
    let runFg: string | undefined;
    let runBg: string | undefined;
    let runAttributes = 0;

    const flushRun = (): void => {
      if (runText.length === 0) {
        return;
      }
      const span: VtSpan = { text: runText, width: runWidth, attributes: runAttributes };
      if (runFg !== undefined) {
        span.fg = runFg;
      }
      if (runBg !== undefined) {
        span.bg = runBg;
      }
      spans.push(span);
      runText = "";
      runWidth = 0;
    };

    if (line !== undefined) {
      for (let colIndex = 0; colIndex < terminal.cols; colIndex++) {
        const cell = line.getCell(colIndex, workCell);
        if (cell === undefined || cell.getWidth() === 0) {
          // Width-0 cells continue the preceding wide character.
          continue;
        }

        const fg = cellForeground(cell, palette);
        const bg = cellBackground(cell, palette);
        let attributes = cellAttributes(cell);
        if (cursorVisible && rowIndex === cursorRow && colIndex === cursorCol) {
          // XOR so a cursor over already-inverse content flips back to normal.
          attributes ^= TextAttributes.INVERSE;
        }

        const text = cell.getChars() || " ";
        if (fg !== runFg || bg !== runBg || attributes !== runAttributes) {
          flushRun();
          runFg = fg;
          runBg = bg;
          runAttributes = attributes;
        }
        runText += text;
        runWidth += Math.max(cell.getWidth(), 1);
      }
    }

    flushRun();
    trimTrailingPlainWhitespace(spans);
    rows.push({ spans });
  }

  return rows;
}

function cellForeground(cell: IBufferCell, palette: readonly string[]): string | undefined {
  if (cell.isFgRGB()) {
    return rgbToHexColor(cell.getFgColor());
  }
  if (cell.isFgPalette()) {
    return palette[cell.getFgColor()];
  }
  return undefined;
}

function cellBackground(cell: IBufferCell, palette: readonly string[]): string | undefined {
  if (cell.isBgRGB()) {
    return rgbToHexColor(cell.getBgColor());
  }
  if (cell.isBgPalette()) {
    return palette[cell.getBgColor()];
  }
  return undefined;
}

function cellAttributes(cell: IBufferCell): number {
  let attributes = TextAttributes.NONE;
  if (cell.isBold()) {
    attributes |= TextAttributes.BOLD;
  }
  if (cell.isDim()) {
    attributes |= TextAttributes.DIM;
  }
  if (cell.isItalic()) {
    attributes |= TextAttributes.ITALIC;
  }
  if (cell.isUnderline()) {
    attributes |= TextAttributes.UNDERLINE;
  }
  // BLINK is deliberately dropped: rarely intended, always distracting.
  if (cell.isInverse()) {
    attributes |= TextAttributes.INVERSE;
  }
  if (cell.isInvisible()) {
    attributes |= TextAttributes.HIDDEN;
  }
  if (cell.isStrikethrough()) {
    attributes |= TextAttributes.STRIKETHROUGH;
  }
  return attributes;
}

// Styled whitespace must survive (statuslines are bg-colored spaces); only
// plain trailing space cells are trimmed, including the tail of a span that
// mixes text and the row's empty remainder.
function trimTrailingPlainWhitespace(spans: VtSpan[]): void {
  while (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (
      last === undefined ||
      last.fg !== undefined ||
      last.bg !== undefined ||
      last.attributes !== 0
    ) {
      return;
    }
    const trimmed = last.text.replace(/ +$/, "");
    if (trimmed === last.text) {
      return;
    }
    if (trimmed.length === 0) {
      spans.pop();
      continue;
    }
    // Trailing blanks are always width-1 cells, so width shrinks 1:1.
    last.width -= last.text.length - trimmed.length;
    last.text = trimmed;
    return;
  }
}
