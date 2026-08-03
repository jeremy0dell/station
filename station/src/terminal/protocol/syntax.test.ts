import { describe, expect, it } from "bun:test";
import { C0, VtPrefix, VtTerminator } from "./syntax.js";

describe("VT syntax categories", () => {
  it("pins C0 bytes separately from multi-byte prefixes", () => {
    expect(C0.Bell).toBe("\x07");
    expect(C0.Escape).toBe("\x1b");
    expect(VtPrefix.Csi).toBe("\x1b[");
    expect(VtPrefix.Osc).toBe("\x1b]");
    expect(VtPrefix.Dcs).toBe("\x1bP");
    expect(VtPrefix.Apc).toBe("\x1b_");
    expect(VtPrefix.Ss3).toBe("\x1bO");
  });

  it("pins the supported string terminators", () => {
    expect(VtTerminator.Bell).toBe("\x07");
    expect(VtTerminator.String).toBe("\x1b\\");
  });
});
