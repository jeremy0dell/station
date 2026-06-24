import { describe, expect, it } from "bun:test";
import { orderSelection, rowColumns } from "./selection.js";

const sel = (ax: number, ay: number, fx: number, fy: number) => ({
  anchor: { x: ax, y: ay },
  focus: { x: fx, y: fy },
});

describe("orderSelection", () => {
  it("orders a bottom-up / right-left drag into reading order", () => {
    expect(orderSelection(sel(5, 3, 2, 1))).toEqual({ startX: 2, startY: 1, endX: 5, endY: 3 });
  });
});

describe("rowColumns", () => {
  it("includes both endpoint cells on a single-row selection", () => {
    // cells 2..5 inclusive → half-open [2, 6)
    expect(rowColumns(sel(2, 0, 5, 0), 0, 80)).toEqual({ start: 2, end: 6 });
  });

  it("runs to the line edges on intermediate rows of a multi-row selection", () => {
    const selection = sel(3, 0, 4, 2);
    expect(rowColumns(selection, 0, 80)).toEqual({ start: 3, end: 80 }); // first row: from anchor to edge
    expect(rowColumns(selection, 1, 80)).toEqual({ start: 0, end: 80 }); // middle row: full width
    expect(rowColumns(selection, 2, 80)).toEqual({ start: 0, end: 5 }); // last row: edge to focus (incl)
  });

  it("returns null for rows outside the selection", () => {
    expect(rowColumns(sel(0, 1, 0, 1), 1, 80)).toEqual({ start: 0, end: 1 });
    expect(rowColumns(sel(0, 1, 0, 1), 0, 80)).toBeNull();
    expect(rowColumns(sel(0, 1, 0, 1), 2, 80)).toBeNull();
  });

  it("clamps the inclusive end to the row width", () => {
    expect(rowColumns(sel(0, 0, 79, 0), 0, 80)).toEqual({ start: 0, end: 80 });
  });
});
