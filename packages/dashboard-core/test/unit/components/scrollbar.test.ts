import { describe, expect, it } from "vitest";
import {
  scrollbarOffsetForTrackIndex,
  VERTICAL_SCROLLBAR_EMPTY,
  VERTICAL_SCROLLBAR_THUMB,
  VERTICAL_SCROLLBAR_TRACK,
  verticalScrollbarCells,
} from "../../../src/components/scrollbar.js";

function thumbSize(input: {
  trackHeight: number;
  contentLength: number;
  viewportLength: number;
}): number {
  return verticalScrollbarCells({ ...input, offset: 0 }).filter(
    (cell) => cell === VERTICAL_SCROLLBAR_THUMB,
  ).length;
}

describe("verticalScrollbarCells", () => {
  it("fills the track with spaces when content fits", () => {
    expect(
      verticalScrollbarCells({
        trackHeight: 5,
        contentLength: 5,
        viewportLength: 5,
        offset: 0,
      }),
    ).toEqual(Array.from({ length: 5 }, () => VERTICAL_SCROLLBAR_EMPTY));
  });

  it("places a proportional thumb at the top, middle, and bottom", () => {
    const input = {
      trackHeight: 18,
      contentLength: 22,
      viewportLength: 18,
    };
    const top = verticalScrollbarCells({ ...input, offset: 0 }).join("");
    const bottom = verticalScrollbarCells({ ...input, offset: 4 }).join("");

    expect(top.startsWith(VERTICAL_SCROLLBAR_THUMB.repeat(15))).toBe(true);
    expect(top.endsWith(VERTICAL_SCROLLBAR_TRACK.repeat(3))).toBe(true);
    expect(bottom.startsWith(VERTICAL_SCROLLBAR_TRACK.repeat(3))).toBe(true);
    expect(bottom.endsWith(VERTICAL_SCROLLBAR_THUMB.repeat(15))).toBe(true);
    expect(verticalScrollbarCells({ ...input, offset: 2 }).join("")).toContain(
      VERTICAL_SCROLLBAR_THUMB,
    );
  });

  it("keeps a one-cell thumb for a tiny viewport", () => {
    expect(
      verticalScrollbarCells({
        trackHeight: 4,
        contentLength: 20,
        viewportLength: 1,
        offset: 0,
      }),
    ).toEqual([
      VERTICAL_SCROLLBAR_THUMB,
      VERTICAL_SCROLLBAR_TRACK,
      VERTICAL_SCROLLBAR_TRACK,
      VERTICAL_SCROLLBAR_TRACK,
    ]);
  });

  it("shrinks the thumb as content grows, using Blink visible/content * track", () => {
    const track = { trackHeight: 17, viewportLength: 17 };
    expect(thumbSize({ ...track, contentLength: 17 })).toBe(0);
    expect(thumbSize({ ...track, contentLength: 18 })).toBe(16);
    expect(thumbSize({ ...track, contentLength: 34 })).toBe(9);
    expect(thumbSize({ ...track, contentLength: 300 })).toBe(1);
  });
});

describe("scrollbarOffsetForTrackIndex", () => {
  it("maps the first and last track cells to the scroll range", () => {
    const input = {
      trackHeight: 18,
      contentLength: 22,
      viewportLength: 18,
      offset: 0,
    };
    expect(scrollbarOffsetForTrackIndex({ ...input, trackIndex: 0 })).toBe(0);
    expect(scrollbarOffsetForTrackIndex({ ...input, trackIndex: 17 })).toBe(4);
  });

  it("returns 0 when content fits", () => {
    expect(
      scrollbarOffsetForTrackIndex({
        trackHeight: 10,
        contentLength: 5,
        viewportLength: 10,
        offset: 0,
        trackIndex: 7,
      }),
    ).toBe(0);
  });
});
