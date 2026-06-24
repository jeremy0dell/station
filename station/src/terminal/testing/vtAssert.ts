import { expect } from "bun:test";
import type { VtCase } from "../vt/cases/types.js";
import type { VtSpan } from "../vt/rows.js";
import type { StationVtScreen } from "../vt/screen.js";

// Assertions read through the StationVtScreen view (not the engine), so the
// conformance catalog doubles as an engine-agnostic acceptance suite.

export function visibleRowText(screen: StationVtScreen, rowIndex: number): string {
  return screen.rowText(rowIndex);
}

/** The style-run covering a visible grid column, from the production path. */
export function spanAtColumn(
  screen: StationVtScreen,
  rowIndex: number,
  colIndex: number,
): VtSpan | undefined {
  const rows = screen.buildRows({ cursorVisible: false });
  const row = rows[rowIndex];
  if (row === undefined) {
    return undefined;
  }
  let col = 0;
  for (const span of row.spans) {
    if (colIndex < col + span.width) {
      return span;
    }
    col += span.width;
  }
  return undefined;
}

export function charAtCell(screen: StationVtScreen, rowIndex: number, colIndex: number): string {
  // Per-cell glyph reads have no column-accurate equivalent in the view
  // (wide chars break string indexing); this is a legitimate escape-hatch use.
  const buffer = screen.unsafeEngine.buffer.active;
  const cell = buffer.getLine(buffer.baseY + rowIndex)?.getCell(colIndex);
  return cell?.getChars() ?? "";
}

export async function assertVtCase(screen: StationVtScreen, vtCase: VtCase): Promise<void> {
  const chunks = typeof vtCase.feed === "string" ? [vtCase.feed] : vtCase.feed;
  for (const chunk of chunks) {
    screen.feed(chunk);
  }
  await screen.whenIdle();

  const expected = vtCase.expect;

  if (expected.rows !== undefined) {
    const actualRows = expected.rows.map((_, index) => screen.rowText(index));
    expect(actualRows).toEqual([...expected.rows]);
  }

  if (expected.cells !== undefined) {
    for (const cell of expected.cells) {
      const [rowIndex, colIndex] = cell.at;
      if (cell.char !== undefined) {
        expect({ at: cell.at, char: charAtCell(screen, rowIndex, colIndex) }).toEqual({
          at: cell.at,
          char: cell.char,
        });
      }
      const span = spanAtColumn(screen, rowIndex, colIndex);
      const checksStyle =
        cell.fg !== undefined ||
        cell.bg !== undefined ||
        cell.fgDefault !== undefined ||
        cell.bgDefault !== undefined ||
        cell.attributes !== undefined;
      if (checksStyle) {
        const actual: Record<string, unknown> = { at: cell.at };
        const wanted: Record<string, unknown> = { at: cell.at };
        if (cell.fg !== undefined || cell.fgDefault !== undefined) {
          actual.fg = span?.fg;
          wanted.fg = cell.fg;
        }
        if (cell.bg !== undefined || cell.bgDefault !== undefined) {
          actual.bg = span?.bg;
          wanted.bg = cell.bg;
        }
        if (cell.attributes !== undefined) {
          actual.attributes = span?.attributes;
          wanted.attributes = cell.attributes;
        }
        expect(actual).toEqual(wanted);
      }
    }
  }

  if (expected.cursor !== undefined) {
    expect(screen.cursor()).toEqual(expected.cursor);
  }

  if (expected.altScreen !== undefined) {
    expect(screen.isAltScreen()).toBe(expected.altScreen);
  }

  if (expected.baseY !== undefined) {
    expect(screen.bufferStats().baseY).toBe(expected.baseY);
  }

  if (expected.bufferLengthAtMost !== undefined) {
    expect(screen.bufferStats().length).toBeLessThanOrEqual(expected.bufferLengthAtMost);
  }
}
