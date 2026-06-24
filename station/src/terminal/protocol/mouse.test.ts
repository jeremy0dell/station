import { describe, expect, it } from "bun:test";
import {
  encodeMouseButtonByte,
  legacyMouseReport,
  MouseEncoding,
  MouseModifierBit,
  MouseMotionBit,
  MouseTracking,
  sgrMouseReport,
} from "./mouse.js";

describe("mouse protocol vocabulary", () => {
  // The collision fix is name-only: MouseEncoding.Legacy and MouseTracking.X10
  // are distinct symbols but the encoding's runtime value MUST stay "x10" (it is
  // the wire contract that screen.ts/mouseReport.ts/tests depend on).
  it("pins the runtime wire values that disambiguation must not change", () => {
    expect(MouseTracking.X10).toBe("x10");
    expect(MouseEncoding.Legacy).toBe("x10");
    expect(MouseEncoding.Sgr).toBe("sgr");
    // Distinct catalogs, even though X10 and Legacy share the underlying string.
    expect(MouseTracking.X10).toBe(MouseEncoding.Legacy);
  });

  it("folds motion and modifier bits onto the base button code", () => {
    expect(encodeMouseButtonByte({ base: 3, motion: true })).toBe(3 + MouseMotionBit);
    expect(
      encodeMouseButtonByte({ base: 0, modifiers: { shift: true, alt: false, ctrl: true } }),
    ).toBe(MouseModifierBit.Shift + MouseModifierBit.Ctrl);
  });

  it("builds SGR and legacy reports in the expected wire form", () => {
    expect(sgrMouseReport(0, 3, 1, false)).toBe("\x1b[<0;3;1M");
    expect(sgrMouseReport(0, 3, 1, true)).toBe("\x1b[<0;3;1m");
    // cb 0 -> ' ' (0x20); col 3 -> '#' (0x23); row 1 -> '!' (0x21).
    expect(legacyMouseReport(0, 3, 1)).toBe("\x1b[M \x23\x21");
  });
});
