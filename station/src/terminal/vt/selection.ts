/**
 * Linear (text-flow) selection over the VT grid, in renderable-local cell
 * coordinates. A selection runs from an anchor cell to a focus cell; rows
 * between the two endpoints select to the line edges, like selecting text in an
 * editor (not a rectangular block). Both endpoint cells are included.
 */
export type CellPoint = { x: number; y: number };
export type CellSelection = { anchor: CellPoint; focus: CellPoint };

export type RowColumns = { start: number; end: number };
export type OrderedSelection = { startX: number; startY: number; endX: number; endY: number };

/** Anchor/focus ordered into reading order (top-to-bottom, left-to-right). */
export function orderSelection(selection: CellSelection): OrderedSelection {
  const { anchor, focus } = selection;
  const anchorFirst = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
  const start = anchorFirst ? anchor : focus;
  const end = anchorFirst ? focus : anchor;
  return { startX: start.x, startY: start.y, endX: end.x, endY: end.y };
}

/**
 * Half-open selected column range for one row; callers order once, then reuse
 * this for translateToString and drawText selection ranges.
 */
export function rowColumnsOrdered(
  ordered: OrderedSelection,
  row: number,
  width: number,
): RowColumns | null {
  if (row < ordered.startY || row > ordered.endY) {
    return null;
  }
  const start = row === ordered.startY ? ordered.startX : 0;
  const endExclusive = row === ordered.endY ? ordered.endX + 1 : width;
  const lo = clamp(start, 0, width);
  const hi = clamp(endExclusive, 0, width);
  if (hi <= lo) {
    return null;
  }
  return { start: lo, end: hi };
}

/** Convenience wrapper for a single-row lookup. */
export function rowColumns(
  selection: CellSelection,
  row: number,
  width: number,
): RowColumns | null {
  return rowColumnsOrdered(orderSelection(selection), row, width);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
