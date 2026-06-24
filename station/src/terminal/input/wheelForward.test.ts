import { describe, expect, it } from "bun:test";
import { buildWheelForwardSequence } from "./wheelForward.js";

const base = {
  cols: 80,
  rows: 24,
  applicationCursorKeys: false,
  lines: 3,
} as const;

describe("buildWheelForwardSequence", () => {
  it("emits an SGR wheel press at the viewport center for mouse-reporting apps", () => {
    expect(
      buildWheelForwardSequence({ ...base, direction: "up", mouseReporting: true }),
    ).toBe("\x1b[<64;40;12M");
    expect(
      buildWheelForwardSequence({ ...base, direction: "down", mouseReporting: true }),
    ).toBe("\x1b[<65;40;12M");
  });

  it("emits normal arrow keys, one per line, for alt-screen pagers", () => {
    expect(
      buildWheelForwardSequence({ ...base, direction: "up", mouseReporting: false }),
    ).toBe("\x1b[A\x1b[A\x1b[A");
    expect(
      buildWheelForwardSequence({ ...base, direction: "down", mouseReporting: false }),
    ).toBe("\x1b[B\x1b[B\x1b[B");
  });

  it("respects application cursor keys (DECCKM)", () => {
    expect(
      buildWheelForwardSequence({
        ...base,
        direction: "up",
        mouseReporting: false,
        applicationCursorKeys: true,
      }),
    ).toBe("\x1bOA\x1bOA\x1bOA");
  });

  it("keeps the synthetic wheel cell on a tiny viewport", () => {
    expect(
      buildWheelForwardSequence({
        ...base,
        cols: 1,
        rows: 1,
        direction: "up",
        mouseReporting: true,
      }),
    ).toBe("\x1b[<64;1;1M");
  });
});
