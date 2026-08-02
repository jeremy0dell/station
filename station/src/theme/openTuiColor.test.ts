import { describe, expect, it } from "bun:test";
import { rgbToHex } from "@opentui/core";
import { alphaColor, indexedColor, rgbColor, terminalDefaultColor } from "./types.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor } from "./openTuiColor.js";

function rgba(value: ReturnType<typeof toOpenTuiColor>) {
  if (typeof value === "string") {
    throw new Error("Expected an OpenTUI RGBA value.");
  }
  return value;
}

describe("OpenTUI Station color adapter", () => {
  it("passes explicit RGB through unchanged", () => {
    expect(toOpenTuiColor(rgbColor("#010203"))).toBe("#010203");
  });

  it("preserves indexed ANSI intent and the observed RGB snapshot", () => {
    const value = rgba(toOpenTuiColor(indexedColor(1, rgbColor("#cd3131"))));
    expect(value.intent).toBe("indexed");
    expect(value.slot).toBe(1);
    expect(rgbToHex(value)).toBe("#cd3131");
  });

  it("preserves terminal-default intent and snapshot", () => {
    const value = rgba(toOpenTuiColor(terminalDefaultColor("background", rgbColor("#101316"))));
    expect(value.intent).toBe("default");
    expect(rgbToHex(value)).toBe("#101316");
  });

  it("preserves alpha intent as RGBA", () => {
    const value = rgba(toOpenTuiColor(alphaColor(rgbColor("#336699"), 0.5)));
    expect(value.intent).toBe("rgb");
    expect(value.toInts()).toEqual([51, 102, 153, 128]);
  });

  it("rejects alpha intent at the opaque-role type boundary", () => {
    const translucent = alphaColor(rgbColor("#010203"), 0.5);
    // @ts-expect-error Alpha intent cannot be assigned to an opaque surface role.
    const invalidOpaque: Parameters<typeof toOpenTuiOpaqueColor>[0] = translucent;
    expect(invalidOpaque.kind).toBe("alpha");
    expect(toOpenTuiOpaqueColor(rgbColor("#010203"))).toBe("#010203");
  });
});
