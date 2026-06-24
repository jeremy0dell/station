import { describe, expect, it } from "bun:test";
import { measureContextMenu, placeContextMenu } from "./placement.js";
import type { ContextMenuItem } from "./types.js";

const ITEMS: readonly ContextMenuItem[] = [
  { id: "pane.splitRight", label: "Split Right", disabled: true, action: { kind: "noop" } },
  { id: "pane.splitBelow", label: "Split Below", disabled: true, action: { kind: "noop" } },
  { id: "pane.close", label: "Close Pane", action: { kind: "closePane", paneId: "pane-a" } },
];

describe("context menu placement", () => {
  it("measures labels plus border and row height", () => {
    expect(measureContextMenu(ITEMS)).toEqual({ width: 15, height: 5 });
  });

  it("uses bottom-start placement by default", () => {
    expect(placeContextMenu({ x: 4, y: 3 }, { width: 10, height: 4 }, { width: 40, height: 20 })).toEqual({
      left: 4,
      top: 4,
      width: 10,
      height: 4,
    });
  });

  it("shifts left near the right edge", () => {
    expect(placeContextMenu({ x: 38, y: 3 }, { width: 10, height: 4 }, { width: 40, height: 20 })).toEqual({
      left: 30,
      top: 4,
      width: 10,
      height: 4,
    });
  });

  it("flips above near the bottom edge", () => {
    expect(placeContextMenu({ x: 4, y: 19 }, { width: 10, height: 4 }, { width: 40, height: 20 })).toEqual({
      left: 4,
      top: 15,
      width: 10,
      height: 4,
    });
  });

  it("clamps into tiny terminal bounds", () => {
    expect(placeContextMenu({ x: 10, y: 10 }, { width: 20, height: 8 }, { width: 6, height: 3 })).toEqual({
      left: 0,
      top: 0,
      width: 6,
      height: 3,
    });
  });
});
