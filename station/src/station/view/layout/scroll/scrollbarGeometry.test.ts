import { describe, expect, it } from "bun:test";
import { scrollbarThumbGeometry, scrollbarTrackEndpoint } from "./scrollbarGeometry.js";

describe("scrollbar geometry", () => {
  it("hides the thumb when content does not overflow", () => {
    expect(
      scrollbarThumbGeometry({
        trackHeight: 8,
        contentHeight: 8,
        viewportHeight: 8,
        scrollPosition: 0,
      }),
    ).toEqual({ trackHeight: 8, thumbTop: 0, thumbHeight: 0, overflow: false });
  });

  it("keeps a whole-cell thumb stable while clamping scroll offsets", () => {
    const atTop = scrollbarThumbGeometry({
      trackHeight: 8,
      contentHeight: 20,
      viewportHeight: 5,
      scrollPosition: -100,
    });
    const atBottom = scrollbarThumbGeometry({
      trackHeight: 8,
      contentHeight: 20,
      viewportHeight: 5,
      scrollPosition: 100,
    });

    expect(atTop.thumbHeight).toBe(2);
    expect(atTop.thumbTop).toBe(0);
    expect(atBottom.thumbHeight).toBe(atTop.thumbHeight);
    expect(atBottom.thumbTop).toBe(6);
  });

  it("normalizes a zero track without producing a thumb", () => {
    expect(
      scrollbarThumbGeometry({
        trackHeight: 0,
        contentHeight: 20,
        viewportHeight: 5,
        scrollPosition: 4,
      }),
    ).toEqual({ trackHeight: 0, thumbTop: 0, thumbHeight: 0, overflow: false });
  });

  it("snaps only the first and last track cells to scroll endpoints", () => {
    const input = { trackHeight: 8, contentHeight: 20, viewportHeight: 5 } as const;

    expect(scrollbarTrackEndpoint({ ...input, localY: -1 })).toBe(0);
    expect(scrollbarTrackEndpoint({ ...input, localY: 3 })).toBeUndefined();
    expect(scrollbarTrackEndpoint({ ...input, localY: 7 })).toBe(15);
    expect(scrollbarTrackEndpoint({ ...input, localY: 8 })).toBe(15);
    expect(scrollbarTrackEndpoint({ ...input, localY: 0, trackHeight: 1 })).toBeUndefined();
  });
});
