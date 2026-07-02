import { describe, expect, it } from "vitest";
import { formatMoonWidget, moonPhase } from "../../../src/widgets/moon.js";

describe("moonPhase", () => {
  it("hits the anchor phases of the reference cycle", () => {
    // The epoch new moon itself, then quarter offsets of the synodic month.
    expect(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14))).name).toBe("new moon");
    expect(moonPhase(new Date(Date.UTC(2000, 0, 14, 2, 0))).name).toBe("first quarter");
    expect(moonPhase(new Date(Date.UTC(2000, 0, 21, 5, 0))).name).toBe("full moon");
    expect(moonPhase(new Date(Date.UTC(2000, 0, 28, 8, 0))).name).toBe("last quarter");
  });

  it("handles dates before the epoch", () => {
    // One full synodic month earlier is a new moon again.
    expect(moonPhase(new Date(Date.UTC(1999, 11, 8, 5, 30))).name).toBe("new moon");
  });
});

describe("formatMoonWidget", () => {
  it("pairs the glyph with the phase name, compacting to the glyph alone", () => {
    const widget = formatMoonWidget(new Date(Date.UTC(2000, 0, 21, 5, 0)));
    expect(widget).toEqual({ text: "🌕 full moon", compact: "🌕" });
  });
});
