import { rgbColor, type StationRgbColor } from "../types.js";

/** WCAG contrast target for ordinary text and inverse action text. */
export const STATION_TEXT_CONTRAST_RATIO = 4.5;
/** WCAG contrast target for borders, disabled treatment, and interaction boundaries. */
export const STATION_BOUNDARY_CONTRAST_RATIO = 3;

export const SRGB_CHANNEL_MAX = 255;

type RgbTriplet = readonly [number, number, number];

/** Blends toward a known readable color until the requested contrast is met. */
export function blendUntilContrast(
  start: StationRgbColor,
  toward: StationRgbColor,
  background: StationRgbColor,
  target: number,
): StationRgbColor {
  if (contrastRatio(start, background) >= target) {
    return start;
  }
  for (let step = 1; step <= SRGB_CHANNEL_MAX; step += 1) {
    const candidate = mixRgb(start, toward, step / SRGB_CHANNEL_MAX);
    if (contrastRatio(candidate, background) >= target) {
      return candidate;
    }
  }
  return toward;
}

/** Mixes two normalized sRGB colors using an amount clamped to the inclusive unit interval. */
export function mixRgb(
  from: StationRgbColor,
  to: StationRgbColor,
  amount: number,
): StationRgbColor {
  const fromRgb = rgbTriplet(from);
  const toRgb = rgbTriplet(to);
  const clamped = Math.max(0, Math.min(1, amount));
  return rgbFromTriplet([
    Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * clamped),
    Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * clamped),
    Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * clamped),
  ]);
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
    const channel = component / SRGB_CHANNEL_MAX;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function rgbTriplet(color: StationRgbColor): RgbTriplet {
  return [
    Number.parseInt(color.value.slice(1, 3), 16),
    Number.parseInt(color.value.slice(3, 5), 16),
    Number.parseInt(color.value.slice(5, 7), 16),
  ];
}

function rgbFromTriplet([red, green, blue]: RgbTriplet): StationRgbColor {
  const value = [red, green, blue]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("");
  return rgbColor(`#${value}`);
}
