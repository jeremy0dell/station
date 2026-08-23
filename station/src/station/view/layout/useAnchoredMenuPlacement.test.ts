import { describe, expect, it } from "bun:test";
import { anchoredMenuPlacement } from "./useAnchoredMenuPlacement.js";

describe("anchored semantic menu placement", () => {
  it("uses measured boxes to place below, flip above, and clip to the owner", () => {
    expect(
      anchoredMenuPlacement({ top: 0, height: 20 }, { top: 3, height: 1 }, 4),
    ).toEqual({ top: 4, maxHeight: 4 });
    expect(
      anchoredMenuPlacement({ top: 0, height: 20 }, { top: 19, height: 1 }, 4),
    ).toEqual({ top: 15, maxHeight: 4 });
    expect(
      anchoredMenuPlacement({ top: 0, height: 3 }, { top: 2, height: 1 }, 8),
    ).toEqual({ top: 0, maxHeight: 3 });
  });
});
