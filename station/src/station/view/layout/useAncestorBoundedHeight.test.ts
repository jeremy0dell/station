import { describe, expect, it } from "bun:test";
import {
  availableHeightWithin,
  boundedIntrinsicOverlayLayout,
} from "./useAncestorBoundedHeight.js";

describe("ancestor-bounded overlay geometry", () => {
  it("uses measured structural coordinates instead of reserved screen rows", () => {
    expect(availableHeightWithin({ top: 2, height: 18 }, { top: 6 })).toBe(14);
    expect(availableHeightWithin({ top: 4, height: 3 }, { top: 9 })).toBe(1);
  });

  it("keeps intrinsic content while assigning one platform-stable bounded layout", () => {
    expect(
      boundedIntrinsicOverlayLayout({
        availableHeight: 6,
        decorationHeight: 5,
        contentHeight: 3,
      }),
    ).toEqual({ overlayHeight: 6, viewportHeight: 1 });
    expect(
      boundedIntrinsicOverlayLayout({
        availableHeight: 14,
        decorationHeight: 5,
        contentHeight: 3,
      }),
    ).toEqual({ overlayHeight: 8, viewportHeight: 3 });
    expect(
      boundedIntrinsicOverlayLayout({
        availableHeight: 14,
        decorationHeight: 5,
        contentHeight: 8,
      }),
    ).toEqual({ overlayHeight: 13, viewportHeight: 8 });
    expect(
      boundedIntrinsicOverlayLayout({
        availableHeight: 3,
        decorationHeight: 5,
        contentHeight: 8,
      }),
    ).toEqual({ overlayHeight: 3, viewportHeight: 1 });
  });
});
