import { rgbColor, type StationRgbColor } from "../types.js";
import {
  clampedRGB,
  constrainAngle,
  convert,
  gamutMapOKLCH,
  hexToRGB,
  lerpAngle,
  MapToL,
  OKLab,
  OKLCH,
  RGBToHex,
  sRGB,
  sRGBGamut,
} from "@texel/color";

/** WCAG contrast target for ordinary text and inverse action text. */
export const STATION_TEXT_CONTRAST_RATIO = 4.5;
/** WCAG contrast target for borders, disabled treatment, and interaction boundaries. */
export const STATION_BOUNDARY_CONTRAST_RATIO = 3;

/** Fixed iteration count so identical observations resolve byte-for-byte identically. */
const LIGHTNESS_SEARCH_STEPS = 32;

/** Mixes two colors in OKLCH with shortest-arc hue interpolation; perceptually uniform and chroma-preserving. */
export function mixOklch(
  from: StationRgbColor,
  to: StationRgbColor,
  amount: number,
): StationRgbColor {
  const clamped = Math.max(0, Math.min(1, amount));
  const fromLch = convert(hexToRGB(from.value), sRGB, OKLCH);
  const toLch = convert(hexToRGB(to.value), sRGB, OKLCH);
  const mixed = [
    fromLch[0] + (toLch[0] - fromLch[0]) * clamped,
    fromLch[1] + (toLch[1] - fromLch[1]) * clamped,
    lerpAngle(fromLch[2], toLch[2], clamped),
  ];
  return rgbFromSrgb(convert(mixed, OKLCH, sRGB));
}

/**
 * Moves lightness toward `toward` in OKLab while holding hue and chroma until the
 * contrast target is met on every supplied surface; falls back to the full blend.
 */
export function adjustLightnessForContrast(
  color: StationRgbColor,
  toward: StationRgbColor,
  backgrounds: readonly StationRgbColor[],
  target: number,
): StationRgbColor {
  if (meetsTarget(color, backgrounds, target)) {
    return color;
  }
  const start = convert(hexToRGB(color.value), sRGB, OKLab);
  const destination = convert(hexToRGB(toward.value), sRGB, OKLab);
  const shift = destination[0] - start[0];
  let low = 0;
  let high = 1;
  for (let step = 0; step < LIGHTNESS_SEARCH_STEPS; step += 1) {
    const t = (low + high) / 2;
    if (meetsTarget(rgbFromOklab([start[0] + t * shift, start[1], start[2]]), backgrounds, target)) {
      high = t;
    } else {
      low = t;
    }
  }
  const corrected = rgbFromOklab([start[0] + high * shift, start[1], start[2]]);
  if (meetsTarget(corrected, backgrounds, target)) {
    return corrected;
  }
  // A hue that cannot reach the target on this surface; the full blend is the last deterministic resort.
  return rgbFromSrgb(hexToRGB(toward.value));
}

/** Returns the WCAG contrast ratio between two normalized sRGB colors. */
export function contrastRatio(first: StationRgbColor, second: StationRgbColor): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Returns WCAG relative luminance for a normalized sRGB color. */
export function relativeLuminance(color: StationRgbColor): number {
  const [red, green, blue] = rgbTriplet(color).map((component) => {
    const channel = component / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function meetsTarget(
  color: StationRgbColor,
  backgrounds: readonly StationRgbColor[],
  target: number,
): boolean {
  return backgrounds.every((background) => contrastRatio(color, background) >= target);
}

function rgbFromOklab(oklab: readonly [number, number, number]): StationRgbColor {
  const [lightness, a, b] = oklab;
  const chroma = Math.hypot(a, b);
  const lch =
    chroma === 0
      ? [lightness, 0, 0]
      : gamutMapOKLCH(
          [lightness, chroma, constrainAngle((Math.atan2(b, a) * 180) / Math.PI)],
          sRGBGamut,
          OKLCH,
          undefined,
          // Hold the searched lightness; cusp mapping would move L to the hue's
          // cusp and defeat contrast searches on saturated accents.
          MapToL,
        );
  return rgbFromSrgb(convert(lch, OKLCH, sRGB));
}

function rgbFromSrgb(rgb: readonly number[]): StationRgbColor {
  return rgbColor(RGBToHex(clampedRGB([...rgb])) as `#${string}`);
}

function rgbTriplet(color: StationRgbColor): [number, number, number] {
  return [
    Number.parseInt(color.value.slice(1, 3), 16),
    Number.parseInt(color.value.slice(3, 5), 16),
    Number.parseInt(color.value.slice(5, 7), 16),
  ];
}
