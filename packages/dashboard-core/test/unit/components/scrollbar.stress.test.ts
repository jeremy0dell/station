import { describe, expect, it } from "vitest";
import {
  scrollbarOffsetForTrackIndex,
  VERTICAL_SCROLLBAR_THUMB,
  verticalScrollbarCells,
} from "../../../src/components/scrollbar.js";

const STRESS_CASES = [
  { trackHeight: 17, contentLength: 300, viewportLength: 17 },
  { trackHeight: 17, contentLength: 301, viewportLength: 17 },
  { trackHeight: 18, contentLength: 300, viewportLength: 18 },
  { trackHeight: 9, contentLength: 300, viewportLength: 9 },
  { trackHeight: 17, contentLength: 3000, viewportLength: 17 },
  { trackHeight: 4, contentLength: 20, viewportLength: 1 },
  { trackHeight: 18, contentLength: 22, viewportLength: 18 },
  { trackHeight: 17, contentLength: 18, viewportLength: 17 },
] as const;

describe("vertical scrollbar stress", () => {
  it.each(STRESS_CASES)("maps the first and last track cells to 0 and maxOffset (%o)", (input) => {
    const maxOffset = input.contentLength - input.viewportLength;
    expect(scrollbarOffsetForTrackIndex({ ...input, offset: 0, trackIndex: 0 })).toBe(0);
    expect(
      scrollbarOffsetForTrackIndex({
        ...input,
        offset: 0,
        trackIndex: input.trackHeight - 1,
      }),
    ).toBe(maxOffset);
  });

  it.each(STRESS_CASES)("click offsets are monotone and stay in range (%o)", (input) => {
    const maxOffset = input.contentLength - input.viewportLength;
    let previous = 0;
    for (let trackIndex = 0; trackIndex < input.trackHeight; trackIndex += 1) {
      const offset = scrollbarOffsetForTrackIndex({ ...input, offset: 0, trackIndex });
      expect(offset).toBeGreaterThanOrEqual(previous);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(maxOffset);
      previous = offset;
    }
  });

  it.each(
    STRESS_CASES,
  )("keeps a thumb at the start when offset is 0 and at the end at maxOffset (%o)", (input) => {
    const maxOffset = input.contentLength - input.viewportLength;
    const top = verticalScrollbarCells({ ...input, offset: 0 });
    const bottom = verticalScrollbarCells({ ...input, offset: maxOffset });
    expect(top[0]).toBe(VERTICAL_SCROLLBAR_THUMB);
    expect(bottom.at(-1)).toBe(VERTICAL_SCROLLBAR_THUMB);
  });

  it.each(
    STRESS_CASES,
  )("advances offset by 1 even when the painted thumb stays put (%o)", (input) => {
    const maxOffset = input.contentLength - input.viewportLength;
    let stuck = 0;
    let moved = 0;
    let previous = verticalScrollbarCells({ ...input, offset: 0 }).join("");
    for (let offset = 1; offset <= maxOffset; offset += 1) {
      const next = verticalScrollbarCells({ ...input, offset }).join("");
      if (next === previous) {
        stuck += 1;
      } else {
        moved += 1;
      }
      previous = next;
    }
    expect(stuck + moved).toBe(maxOffset);
    expect(moved).toBeGreaterThan(0);
    if (maxOffset > input.trackHeight) {
      expect(stuck).toBeGreaterThan(0);
    }
  });

  it("a one-cell track cannot encode both ends, so clicks collapse to 0", () => {
    expect(
      scrollbarOffsetForTrackIndex({
        trackHeight: 1,
        contentLength: 300,
        viewportLength: 1,
        offset: 0,
        trackIndex: 0,
      }),
    ).toBe(0);
  });

  it.each(STRESS_CASES)("clicking the painted end thumbs returns 0 and maxOffset (%o)", (input) => {
    const maxOffset = input.contentLength - input.viewportLength;
    const top = verticalScrollbarCells({ ...input, offset: 0 });
    const bottom = verticalScrollbarCells({ ...input, offset: maxOffset });
    expect(
      scrollbarOffsetForTrackIndex({
        ...input,
        offset: 0,
        trackIndex: top.indexOf(VERTICAL_SCROLLBAR_THUMB),
      }),
    ).toBe(0);
    expect(
      scrollbarOffsetForTrackIndex({
        ...input,
        offset: 0,
        trackIndex: bottom.lastIndexOf(VERTICAL_SCROLLBAR_THUMB),
      }),
    ).toBe(maxOffset);
  });

  it("clicking a middle thumb cell can jump away from the current offset", () => {
    const input = { trackHeight: 17, contentLength: 300, viewportLength: 17, offset: 100 };
    const thumb = verticalScrollbarCells(input).indexOf(VERTICAL_SCROLLBAR_THUMB);
    expect(scrollbarOffsetForTrackIndex({ ...input, trackIndex: thumb })).not.toBe(input.offset);
  });
});

describe("OpenTUI cell-ratio exclusive end (why we snap last cell)", () => {
  it("maps the last cell through height, not height-1, so it misses maxOffset", () => {
    const height = 17;
    const maxOffset = 283;
    const lastCell = height - 1;
    const clicked = Math.round((lastCell / height) * maxOffset);
    expect(clicked).toBe(266);
    expect(clicked).not.toBe(maxOffset);
  });

  it("maps integer-cell thumb drag through *2 virtual coords, so an odd maxThumbStart is unreachable", () => {
    const height = 17;
    const maxOffset = 283;
    const virtualTrack = height * 2;
    const virtualThumb = 1;
    const maxThumbStart = virtualTrack - virtualThumb;
    const lastCellVirtual = lastCellVirtualPos(height);
    const ratio = lastCellVirtual / maxThumbStart;
    const dragged = Math.round(ratio * maxOffset);
    expect(maxThumbStart).toBe(33);
    expect(lastCellVirtual).toBe(32);
    expect(dragged).toBe(274);
    expect(dragged).not.toBe(maxOffset);
  });
});

function lastCellVirtualPos(height: number): number {
  return (height - 1) * 2;
}
