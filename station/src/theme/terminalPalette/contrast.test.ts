import { describe, expect, it } from "bun:test";
import { rgbColor } from "../types.js";
import {
  blendUntilContrast,
  contrastRatio,
  mixRgb,
  STATION_TEXT_CONTRAST_RATIO,
} from "./contrast.js";

describe("terminal palette contrast math", () => {
  it("calculates the WCAG endpoints", () => {
    const black = rgbColor("#000000");
    const white = rgbColor("#ffffff");

    expect(contrastRatio(black, black)).toBe(1);
    expect(contrastRatio(black, white)).toBe(21);
  });

  it("mixes normalized sRGB channels and clamps the amount", () => {
    const black = rgbColor("#000000");
    const white = rgbColor("#ffffff");

    expect(mixRgb(black, white, 0.5).value).toBe("#808080");
    expect(mixRgb(black, white, -1)).toEqual(black);
    expect(mixRgb(black, white, 2)).toEqual(white);
  });

  it("finds the first 8-bit blend that meets the requested contrast", () => {
    const background = rgbColor("#111827");
    const weak = rgbColor("#202834");
    const foreground = rgbColor("#e5e7eb");
    const corrected = blendUntilContrast(
      weak,
      foreground,
      background,
      STATION_TEXT_CONTRAST_RATIO,
    );

    expect(contrastRatio(corrected, background)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
    expect(corrected).toEqual(
      blendUntilContrast(weak, foreground, background, STATION_TEXT_CONTRAST_RATIO),
    );
  });
});
