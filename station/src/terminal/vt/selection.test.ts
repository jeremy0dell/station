import { describe, expect, it } from "bun:test";
import { orderSelection, rowColumnsOrdered } from "./selection.js";

const sel = (ax: number, ay: number, fx: number, fy: number) => ({
  anchor: { x: ax, y: ay },
  focus: { x: fx, y: fy },
});

describe("orderSelection", () => {
  it("orders a bottom-up / right-left drag into reading order", () => {
    expect(orderSelection(sel(5, 3, 2, 1))).toEqual({ startX: 2, startY: 1, endX: 5, endY: 3 });
  });
});

describe("rowColumnsOrdered", () => {
  it("includes both endpoint cells on a single-row selection", () => {
    const ordered = orderSelection(sel(2, 0, 5, 0));

    // cells 2..5 inclusive → half-open [2, 6)
    expect(rowColumnsOrdered(ordered, 0, 80)).toEqual({ start: 2, end: 6 });
  });

  it("runs to the line edges on intermediate rows of a multi-row selection", () => {
    const ordered = orderSelection(sel(3, 0, 4, 2));

    expect(rowColumnsOrdered(ordered, 0, 80)).toEqual({ start: 3, end: 80 });
    expect(rowColumnsOrdered(ordered, 1, 80)).toEqual({ start: 0, end: 80 });
    expect(rowColumnsOrdered(ordered, 2, 80)).toEqual({ start: 0, end: 5 });
  });

  it("returns null for rows outside the selection", () => {
    const ordered = orderSelection(sel(0, 1, 0, 1));

    expect(rowColumnsOrdered(ordered, 1, 80)).toEqual({ start: 0, end: 1 });
    expect(rowColumnsOrdered(ordered, 0, 80)).toBeNull();
    expect(rowColumnsOrdered(ordered, 2, 80)).toBeNull();
  });

  it("clamps the inclusive end to the row width", () => {
    const ordered = orderSelection(sel(0, 0, 79, 0));

    expect(rowColumnsOrdered(ordered, 0, 80)).toEqual({ start: 0, end: 80 });
  });
});
