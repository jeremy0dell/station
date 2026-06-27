import { describe, expect, it } from "bun:test";
import { MouseEncoding } from "../protocol/mouse.js";
import { buildWheelForwardSequence } from "./wheelForward.js";

const base = {
  cols: 80,
  rows: 24,
  applicationCursorKeys: false,
  lines: 3,
  encoding: MouseEncoding.Sgr,
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

  it("emits a legacy wheel report when the app negotiated legacy encoding (no DECSET 1006)", () => {
    // 64 (wheel up) and center cells 40/12 each +32 in the legacy byte form.
    expect(
      buildWheelForwardSequence({
        ...base,
        direction: "up",
        mouseReporting: true,
        encoding: MouseEncoding.Legacy,
      }),
    ).toBe(`\x1b[M${String.fromCharCode(96)}${String.fromCharCode(72)}${String.fromCharCode(44)}`);
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
