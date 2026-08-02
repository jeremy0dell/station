import { describe, expect, it } from "bun:test";
import {
  alphaColor,
  indexedColor,
  rgbColor,
  stationColorSnapshot,
  terminalDefaultColor,
  type StationOpaqueBackgroundColor,
} from "./types.js";

describe("Station color intent constructors", () => {
  it("normalizes valid RGB values and rejects malformed values", () => {
    expect(rgbColor("#A1B2C3").value).toBe("#a1b2c3");
    expect(() => rgbColor("#abc")).toThrow();
    expect(() => rgbColor("#gggggg")).toThrow();
  });

  it("requires indexed colors to carry a valid slot and snapshot", () => {
    const snapshot = rgbColor("#cd3131");
    const indexed = indexedColor(1, snapshot);
    expect(indexed).toEqual({ kind: "indexed", index: 1, snapshot });
    expect(() => indexedColor(-1, snapshot)).toThrow();
    expect(() => indexedColor(256, snapshot)).toThrow();
    expect(() => indexedColor(1.5, snapshot)).toThrow();
  });

  it("requires finite fractional alpha", () => {
    const color = rgbColor("#336699");
    expect(alphaColor(color, 0.5)).toEqual({ kind: "alpha", color, alpha: 0.5 });
    expect(() => alphaColor(color, -0.1)).toThrow();
    expect(() => alphaColor(color, 1.1)).toThrow();
    expect(() => alphaColor(color, Number.NaN)).toThrow();
  });

  it("returns deterministic snapshots for every intent", () => {
    const snapshot = rgbColor("#123456");
    expect(stationColorSnapshot(snapshot)).toBe(snapshot);
    expect(stationColorSnapshot(indexedColor(42, snapshot))).toBe(snapshot);
    expect(stationColorSnapshot(terminalDefaultColor("foreground", snapshot))).toBe(snapshot);
    expect(stationColorSnapshot(alphaColor(snapshot, 0.5))).toBe(snapshot);
  });

  it("keeps terminal-default foreground intent out of opaque background roles", () => {
    const snapshot = rgbColor("#101316");
    const background: StationOpaqueBackgroundColor = terminalDefaultColor("background", snapshot);
    expect(background.channel).toBe("background");

    // @ts-expect-error Foreground-default intent cannot be assigned to an opaque background role.
    const invalidBackground: StationOpaqueBackgroundColor = terminalDefaultColor(
      "foreground",
      snapshot,
    );
    expect(invalidBackground.kind).toBe("terminal-default");
  });
});
