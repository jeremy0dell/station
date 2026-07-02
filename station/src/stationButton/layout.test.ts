import { describe, expect, it } from "bun:test";
import { attentionLines, COLLAPSED_BASE_COLS, COLLAPSED_COUNTS_COLS, targetDims } from "./layout.js";

const CALM = { attention: false, workingCount: 0, readyCount: 0, idleCount: 0 } as const;

describe("targetDims", () => {
  it("keeps the expanded card width stable as live counts change", () => {
    const width = (workingCount: number, idleCount: number): number =>
      targetDims(true, { ...CALM, workingCount, idleCount }).width;
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
      targetDims(true, { ...CALM, attention: true, sessionName }).width;
    // A live snapshot shortening (or lengthening) a branch name must not resize
    // the top-right-anchored card out from under a hovering cursor.
    expect(width("feature/a-quite-long-branch-name")).toBe(width("x"));
    expect(width("x")).toBe(width("main"));
    expect(width("main")).toBe(width("another/long-feature-branch-name-here"));
  });

  it("keeps the collapsed counts box width stable as counts tick", () => {
    const dims = (workingCount: number, readyCount: number, idleCount: number) =>
      targetDims(false, { ...CALM, workingCount, readyCount, idleCount, restCounts: true });
    expect(dims(0, 0, 0)).toEqual(dims(9, 10, 99));
    expect(dims(1, 1, 1).width).toBe(COLLAPSED_COUNTS_COLS);
    expect(dims(1, 1, 1).width).toBeGreaterThan(COLLAPSED_BASE_COLS);
    // Counts past the 2-digit paint budget must not overflow either (painted as 99).
    expect(dims(150, 0, 0)).toEqual(dims(0, 0, 0));
  });

  it("keeps the expanded roll-up card width fixed while height tracks project count", () => {
    const dims = (projects: number) =>
      targetDims(true, { ...CALM, projectRollup: Array.from({ length: projects }) });
    expect(dims(1).width).toBe(dims(8).width);
    expect(dims(2).height).toBe(dims(1).height + 1);
    // Past the fold the card shows ROLLUP_MAX_LINES entries plus one "+N more" line.
    expect(dims(6).height).toBe(dims(9).height);
    // An empty roll-up falls back to the totals card.
    expect(dims(0)).toEqual(targetDims(true, CALM));
  });

  it("sizes the celebration box to its PR number and stays put while it shows", () => {
    const celebrate = (prNumber: number) =>
      targetDims(false, { ...CALM, celebration: { prNumber } });
    expect(celebrate(42)).toEqual(celebrate(42));
    expect(celebrate(12345).width).toBe(celebrate(42).width + 3);
    expect(celebrate(42).height).toBe(targetDims(false, CALM).height);
  });
});

describe("attentionLines", () => {
  it("swaps to the queue line only when several sessions ask", () => {
    expect(attentionLines(1)).toEqual(["needs your attention", "↵ or click to focus"]);
    expect(attentionLines(3)).toEqual(["! 3 need you ›", "↵ or click to focus"]);
    // The painted queue depth clamps to the 2-digit width budget.
    expect(attentionLines(120)[0]).toBe("! 99 need you ›");
  });
});
