import { describe, expect, it } from "bun:test";
import { ARROW_KEYS, cursorKeyBytes } from "./cursorKeys.js";

describe("cursor-key (DECCKM) vocabulary", () => {
  // Wire contract: the arrow bytes every consumer (stationInput, wheelForward,
  // sequenceToTuiKey, stationBindings, kittyToLegacy keypad rows) reads from here.
  it("pins the arrow wire bytes for both cursor-key modes", () => {
    expect(ARROW_KEYS.up).toEqual({ normal: "\x1b[A", application: "\x1bOA" });
    expect(ARROW_KEYS.down).toEqual({ normal: "\x1b[B", application: "\x1bOB" });
    expect(ARROW_KEYS.right).toEqual({ normal: "\x1b[C", application: "\x1bOC" });
    expect(ARROW_KEYS.left).toEqual({ normal: "\x1b[D", application: "\x1bOD" });
  });

  it("normalizes either cursor-key form to the same {normal, application} pair", () => {
    const map = cursorKeyBytes();
    // The normalizer's whole job: CSI (DECCKM off) and SS3 (DECCKM on) forms of
    // one arrow resolve to a single pair, so stationInput can re-emit in either
    // mode regardless of which form the child app sent.
    for (const dir of ["up", "down", "left", "right"] as const) {
      const pair = ARROW_KEYS[dir];
      expect(map.get(pair.normal)).toEqual(pair);
      expect(map.get(pair.application)).toEqual(pair);
    }
    expect(map.size).toBe(8); // 4 directions x 2 forms, no collisions
  });

  it("returns undefined for non-arrow sequences", () => {
    const map = cursorKeyBytes();
    expect(map.get("\x1b[Z")).toBeUndefined(); // shift-tab, not an arrow
    expect(map.get("x")).toBeUndefined();
  });
});
