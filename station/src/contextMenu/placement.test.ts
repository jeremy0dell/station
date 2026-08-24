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

  it("includes separator rows in measured height", () => {
    expect(
      measureContextMenu([
        ITEMS[0]!,
        { ...ITEMS[1]!, separatorBefore: true },
        { ...ITEMS[2]!, separatorBefore: true },
      ]),
    ).toEqual({ width: 15, height: 7 });
  });

  it("includes visible keyboard shortcuts in measured width", () => {
    expect(measureContextMenu([{ ...ITEMS[0]!, shortcut: "R" }])).toEqual({
      width: 17,
      height: 3,
    });
  });

  for (const [caseName, label, labelWidth] of [
    ["SGR escapes", "\u001B[31mred\u001B[0m", 3],
    ["OSC escapes", "\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007", 4],
    ["CJK characters", "界", 2],
    ["combining marks", "e\u0301", 1],
    ["bidi and variation selectors", "A\u200F\uFE0F", 1],
    ["emoji modifiers", "👍🏽", 2],
    ["ZWJ emoji", "👩‍💻", 2],
  ] as const) {
    it(`measures ${caseName} by terminal cells`, () => {
      expect(measureContextMenu([{ ...ITEMS[0]!, label }])).toEqual({
        width: labelWidth + 4,
        height: 3,
      });
    });
  }

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
