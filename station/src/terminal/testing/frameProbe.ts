import type { CapturedFrame, CapturedSpan } from "@opentui/core";

/** Character at absolute frame coordinates from a captureCharFrame() string. */
export function frameChar(charFrame: string, row: number, col: number): string {
  const line = charFrame.split("\n")[row] ?? "";
  return [...line][col] ?? "";
}

/** The captured span covering an absolute frame cell, width-aware. */
export function spanAtFrameCell(
  frame: CapturedFrame,
  row: number,
  col: number,
): CapturedSpan | undefined {
  const line = frame.lines[row];
  if (line === undefined) {
    return undefined;
  }
  let cursor = 0;
  for (const span of line.spans) {
    if (col < cursor + span.width) {
      return span;
    }
    cursor += span.width;
  }
  return undefined;
}
