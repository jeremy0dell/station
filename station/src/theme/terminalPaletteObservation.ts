import { z } from "zod";
import { rgbColor, type StationRgbColor } from "./types.js";

const RGB_SCHEMA = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const RGB_OR_NULL_SCHEMA = RGB_SCHEMA.nullable();
const ANSI_16_SCHEMA = z.tuple([
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
  RGB_SCHEMA,
]);

const TERMINAL_COLORS_SCHEMA = z.strictObject({
  palette: ANSI_16_SCHEMA,
  defaultForeground: RGB_SCHEMA,
  defaultBackground: RGB_SCHEMA,
  cursorColor: RGB_OR_NULL_SCHEMA,
  mouseForeground: RGB_OR_NULL_SCHEMA,
  mouseBackground: RGB_OR_NULL_SCHEMA,
  tekForeground: RGB_OR_NULL_SCHEMA,
  tekBackground: RGB_OR_NULL_SCHEMA,
  highlightBackground: RGB_OR_NULL_SCHEMA,
  highlightForeground: RGB_OR_NULL_SCHEMA,
});

/** A complete, normalized snapshot of the terminal defaults and ANSI indices 0-15. */
export type StationTerminalPaletteObservation = Readonly<{
  defaultForeground: StationRgbColor;
  defaultBackground: StationRgbColor;
  ansi16: readonly [
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
    StationRgbColor,
  ];
}>;

/**
 * Strictly parses raw OpenTUI terminal colors without applying OpenTUI's fallback normalizer.
 * Partial, unsupported, malformed, missing, or unexpectedly shaped responses return null.
 */
export function parseStationTerminalPaletteObservation(
  value: unknown,
): StationTerminalPaletteObservation | null {
  const parsed = TERMINAL_COLORS_SCHEMA.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const { palette, defaultForeground, defaultBackground } = parsed.data;
  return {
    defaultForeground: rgbColor(defaultForeground as `#${string}`),
    defaultBackground: rgbColor(defaultBackground as `#${string}`),
    ansi16: [
      rgbColor(palette[0] as `#${string}`),
      rgbColor(palette[1] as `#${string}`),
      rgbColor(palette[2] as `#${string}`),
      rgbColor(palette[3] as `#${string}`),
      rgbColor(palette[4] as `#${string}`),
      rgbColor(palette[5] as `#${string}`),
      rgbColor(palette[6] as `#${string}`),
      rgbColor(palette[7] as `#${string}`),
      rgbColor(palette[8] as `#${string}`),
      rgbColor(palette[9] as `#${string}`),
      rgbColor(palette[10] as `#${string}`),
      rgbColor(palette[11] as `#${string}`),
      rgbColor(palette[12] as `#${string}`),
      rgbColor(palette[13] as `#${string}`),
      rgbColor(palette[14] as `#${string}`),
      rgbColor(palette[15] as `#${string}`),
    ],
  };
}

/** Returns the canonical signature of the 18 colors accepted by the strict parser. */
export function stationTerminalPaletteObservationSignature(
  observation: StationTerminalPaletteObservation,
): string {
  return [
    observation.defaultForeground.value,
    observation.defaultBackground.value,
    ...observation.ansi16.map((color) => color.value),
  ].join("|");
}
