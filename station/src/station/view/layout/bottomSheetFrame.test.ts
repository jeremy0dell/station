import { describe, expect, it } from "bun:test";
import {
  bottomSheetContentWidth,
  bottomSheetFrame,
  compactSheetWidth,
} from "./bottomSheetFrame.js";

describe("bottom sheet render-boundary frame", () => {
  it("holds one preferred block size across wide and tall terminals", () => {
    expect(bottomSheetFrame(120, 40)).toEqual({
      width: 120,
      height: 12,
      contentWidth: 118,
    });
    expect(bottomSheetFrame(80, 24, 46)).toEqual({
      width: 46,
      height: 12,
      contentWidth: 44,
    });
  });

  it("shrinks at terminal edges without exposing invalid dimensions", () => {
    expect(bottomSheetFrame(40, 8)).toEqual({ width: 40, height: 8, contentWidth: 38 });
    expect(bottomSheetFrame(0, 0, 0)).toEqual({ width: 1, height: 1, contentWidth: 1 });
    expect(bottomSheetContentWidth(2)).toBe(1);
    expect(compactSheetWidth(120)).toBe(46);
    expect(compactSheetWidth(0)).toBe(1);
  });
});
