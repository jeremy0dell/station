import { cellWidth, truncateCells } from "../WorktreeRow/layout.js";

export function textLineSegmentsWidth(segments: readonly { text: string }[]): number {
  return segments.reduce((total, segment) => total + cellWidth(segment.text), 0);
}

export function clipTextLineSegments<T extends { text: string }>(
  segments: readonly T[],
  columns: number,
): T[] {
  let remaining = normalizeTextLineWidth(columns);
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

export function normalizeTextLineWidth(columns: number): number {
  return Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
}
