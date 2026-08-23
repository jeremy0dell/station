import { describe, expect, it } from "bun:test";
import { availableHeightWithin } from "./useAncestorBoundedHeight.js";

describe("ancestor-bounded overlay geometry", () => {
  it("uses measured structural coordinates instead of reserved screen rows", () => {
    expect(availableHeightWithin({ top: 2, height: 18 }, { top: 6 })).toBe(14);
    expect(availableHeightWithin({ top: 4, height: 3 }, { top: 9 })).toBe(1);
  });
});
