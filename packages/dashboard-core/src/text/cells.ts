import stringWidth from "string-width";

type GraphemeSegment = {
  readonly index: number;
  readonly segment: string;
};

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" },
) => GraphemeSegmenter;

const graphemeSegmenter = createGraphemeSegmenter();

/** One complete grapheme and its source/text-cell coordinates in sanitized single-line text. */
export type TextCellUnit = {
  readonly text: string;
  readonly sourceIndex: number;
  readonly startCell: number;
  readonly endCell: number;
};

export function cellWidth(text: string): number {
  return stringWidth(sanitizeText(text));
}

/** Segments text without splitting glyph clusters and resolves each segment to terminal cells. */
export function textCellUnits(text: string): readonly TextCellUnit[] {
  const normalized = sanitizeText(text);
  const segments = graphemeSegments(normalized);
  const units: TextCellUnit[] = [];
  let startCell = 0;
  for (const segment of segments) {
    const endCell = startCell + cellWidth(segment.segment);
    units.push({
      text: segment.segment,
      sourceIndex: segment.index,
      startCell,
      endCell,
    });
    startCell = endCell;
  }
  return units;
}

export function truncateCells(text: string, cells: number): string {
  const normalized = sanitizeText(text);
  const limit = normalizeCells(cells);
  if (limit <= 0) return "";
  if (cellWidth(normalized) <= limit) return normalized;
  const ellipsis = "…";
  const ellipsisWidth = cellWidth(ellipsis);
  if (limit < ellipsisWidth) {
    return clipCells(normalized, limit);
  }
  return `${clipCells(normalized, limit - ellipsisWidth)}${ellipsis}`;
}

/** Clips sanitized text to terminal cells without splitting a grapheme cluster. */
export function clipCells(text: string, cells: number): string {
  const normalized = sanitizeText(text);
  let remaining = normalizeCells(cells);
  let clipped = "";
  for (const unit of textCellUnits(normalized)) {
    if (remaining <= 0) break;
    const width = unit.endCell - unit.startCell;
    if (width > remaining) break;
    clipped += unit.text;
    remaining -= width;
  }
  return clipped;
}

function graphemeSegments(text: string): readonly GraphemeSegment[] {
  if (graphemeSegmenter !== undefined) {
    return Array.from(graphemeSegmenter.segment(text));
  }
  const segments: GraphemeSegment[] = [];
  let index = 0;
  for (const segment of Array.from(text)) {
    segments.push({ index, segment });
    index += segment.length;
  }
  return segments;
}

function sanitizeText(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ");
}

function normalizeCells(cells: number): number {
  return Math.max(0, Math.floor(Number.isFinite(cells) ? cells : 0));
}

function createGraphemeSegmenter(): GraphemeSegmenter | undefined {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  return Segmenter === undefined
    ? undefined
    : new Segmenter(undefined, { granularity: "grapheme" });
}
