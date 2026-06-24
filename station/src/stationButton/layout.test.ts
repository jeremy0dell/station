import { describe, expect, it } from "bun:test";
import { targetDims } from "./layout.js";

describe("targetDims", () => {
  it("keeps the expanded card width stable as live counts change", () => {
    const width = (workingCount: number, idleCount: number): number =>
      targetDims(true, { attention: false, workingCount, idleCount }).width;
    // The card is anchored top-right, so any width change slides it out from
    // under a stationary cursor (reads as a hover leave). Counts crossing the
    // singular/plural ("1 session" -> "2 sessions") or digit (9 -> 10) boundary
    // must not resize it.
    expect(width(1, 1)).toBe(width(2, 14));
    expect(width(2, 14)).toBe(width(9, 99));
    expect(width(0, 0)).toBe(width(12, 7));
  });

  it("keeps the attention card width stable as the session name changes", () => {
    const width = (sessionName: string): number =>
      targetDims(true, { attention: true, workingCount: 0, idleCount: 0, sessionName }).width;
    // A live snapshot shortening (or lengthening) a branch name must not resize
    // the top-right-anchored card out from under a hovering cursor.
    expect(width("feature/a-quite-long-branch-name")).toBe(width("x"));
    expect(width("x")).toBe(width("main"));
    expect(width("main")).toBe(width("another/long-feature-branch-name-here"));
  });
});
