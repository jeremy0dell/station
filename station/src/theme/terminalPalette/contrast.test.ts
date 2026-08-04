import { describe, expect, it } from "bun:test";
import { convert, hexToRGB, OKLCH, sRGB } from "@texel/color";
import { rgbColor } from "../types.js";
import {
  adjustLightnessForContrast,
  contrastRatio,
  mixOklch,
  STATION_TEXT_CONTRAST_RATIO,
} from "./contrast.js";

function oklch(value: string): [number, number, number] {
  const lch = convert(hexToRGB(value), sRGB, OKLCH);
  return [lch[0], lch[1], lch[2]];
}

function hue(value: string): number {
  return oklch(value)[2];
}

function hueDistance(first: number, second: number): number {
  const difference = Math.abs(first - second) % 360;
  return Math.min(difference, 360 - difference);
}

describe("terminal palette color math", () => {
  it("calculates the WCAG endpoints", () => {
    const black = rgbColor("#000000");
    const white = rgbColor("#ffffff");

    expect(contrastRatio(black, black)).toBe(1);
    expect(contrastRatio(black, white)).toBe(21);
  });

  it("mixes normalized OKLCH channels and clamps the amount", () => {
    const black = rgbColor("#000000");
    const white = rgbColor("#ffffff");

    expect(mixOklch(black, white, 0)).toEqual(black);
    expect(mixOklch(black, white, 1)).toEqual(white);
    expect(mixOklch(black, white, -1)).toEqual(black);
    expect(mixOklch(black, white, 2)).toEqual(white);
    expect(mixOklch(black, white, 0.5).value).not.toBe("#808080");
  });

  it("mixes perceptually near the midpoint of lightness", () => {
    const mixed = oklch(mixOklch(rgbColor("#000000"), rgbColor("#ffffff"), 0.5).value);

    expect(mixed[0]).toBeGreaterThan(0.45);
    expect(mixed[0]).toBeLessThan(0.55);
  });

  it("keeps the hue when mixing two chromatic colors", () => {
    const mixed = mixOklch(rgbColor("#ff8080"), rgbColor("#ff0000"), 0.5);

    expect(hueDistance(hue(mixed.value), hue("#ff0000"))).toBeLessThan(5);
  });

  it("preserves chroma when mixing toward a near-white surface", () => {
    const mixedLch = oklch(mixOklch(rgbColor("#f9fafb"), rgbColor("#ff0000"), 0.5).value);
    const redChroma = oklch("#ff0000")[1];

    expect(mixedLch[1]).toBeGreaterThan(0.45 * redChroma);
  });

  it("finds the smallest lightness shift that meets the requested contrast", () => {
    const background = rgbColor("#111827");
    const weak = rgbColor("#202834");
    const foreground = rgbColor("#e5e7eb");
    const corrected = adjustLightnessForContrast(
      weak,
      foreground,
      [background],
      STATION_TEXT_CONTRAST_RATIO,
    );

    expect(contrastRatio(corrected, background)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
    expect(corrected).toEqual(
      adjustLightnessForContrast(weak, foreground, [background], STATION_TEXT_CONTRAST_RATIO),
    );
  });

  it("preserves hue and chroma while repairing a weak light accent", () => {
    const background = rgbColor("#f9fafb");
    const weak = rgbColor("#f0c0c0");
    const foreground = rgbColor("#1f2937");
    const corrected = adjustLightnessForContrast(
      weak,
      foreground,
      [background],
      STATION_TEXT_CONTRAST_RATIO,
    );
    const source = oklch("#f0c0c0");
    const result = oklch(corrected.value);

    expect(contrastRatio(corrected, background)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
    expect(Math.abs(result[2] - source[2])).toBeLessThan(6);
    expect(result[1]).toBeGreaterThanOrEqual(0.6 * source[1]);
  });

  it("corrects one foreground against every supplied surface", () => {
    const surfaces = [rgbColor("#111827"), rgbColor("#373d4a")];
    const foreground = rgbColor("#e5e7eb");
    const corrected = adjustLightnessForContrast(
      rgbColor("#f87171"),
      foreground,
      surfaces,
      STATION_TEXT_CONTRAST_RATIO,
    );

    for (const surface of surfaces) {
      expect(contrastRatio(corrected, surface)).toBeGreaterThanOrEqual(
        STATION_TEXT_CONTRAST_RATIO,
      );
    }
  });

  it("holds searched lightness and hue for out-of-gamut saturated accents", () => {
    // The green hue is far outside sRGB gamut at the target foreground
    // lightness; the correction must hold lightness (and with it hue) rather
    // than drifting toward the hue's cusp and collapsing onto the foreground.
    const background = rgbColor("#f9fafb");
    const saturated = rgbColor("#7bff7b");
    const foreground = rgbColor("#1f2937");
    const corrected = adjustLightnessForContrast(
      saturated,
      foreground,
      [background],
      STATION_TEXT_CONTRAST_RATIO,
    );
    const source = oklch("#7bff7b");
    const result = oklch(corrected.value);
    const target = oklch("#1f2937");

    expect(contrastRatio(corrected, background)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
    expect(corrected).not.toEqual(foreground);
    expect(hueDistance(result[2], source[2])).toBeLessThan(6);
    // The minimal lightness shift lands between source and foreground instead
    // of collapsing onto the foreground's own lightness.
    expect(result[0]).toBeLessThan(source[0]);
    expect(result[0]).toBeGreaterThan(target[0]);
    expect(Math.abs(result[0] - target[0])).toBeGreaterThan(0.05);
  });
});
