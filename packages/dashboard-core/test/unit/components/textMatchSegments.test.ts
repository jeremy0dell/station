import { describe, expect, it } from "vitest";
import { textMatchSegments } from "../../../src/components/TextMatch/segments.js";

describe("textMatchSegments", () => {
  it("preserves unmatched text around every matched range", () => {
    expect(
      textMatchSegments("alpha-beta-gamma", [
        { start: 0, end: 5 },
        { start: 11, end: 16 },
      ]),
    ).toEqual([
      { text: "alpha", matched: true },
      { text: "-beta-", matched: false },
      { text: "gamma", matched: true },
    ]);
  });

  it("clamps overlapping and out-of-bounds ranges without duplicating displayed text", () => {
    expect(
      textMatchSegments("alpha", [
        { start: -2, end: 2 },
        { start: 1, end: 8 },
      ]),
    ).toEqual([
      { text: "al", matched: true },
      { text: "pha", matched: true },
    ]);
  });

  it("ignores a range whose end precedes its start", () => {
    expect(textMatchSegments("alpha", [{ start: 4, end: 2 }])).toEqual([
      { text: "alpha", matched: false },
    ]);
  });
});
