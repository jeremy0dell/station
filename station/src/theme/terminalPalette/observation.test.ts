import { describe, expect, it } from "bun:test";
import {
  darkTerminalColors,
  lightTerminalColors,
  malformedTerminalColors,
  unsupportedTerminalColors,
} from "./test/fixtures.js";
import {
  parseStationTerminalPaletteObservation,
  stationTerminalPaletteObservationSignature,
} from "./observation.js";

function mutablePalette(value: typeof darkTerminalColors): Array<string | null> {
  return [...value.palette];
}

describe("strict terminal palette observation", () => {
  it("accepts complete dark and light observations", () => {
    const dark = parseStationTerminalPaletteObservation(darkTerminalColors);
    const light = parseStationTerminalPaletteObservation(lightTerminalColors);

    expect(dark?.defaultForeground.value).toBe(darkTerminalColors.defaultForeground);
    expect(dark?.ansi16).toHaveLength(16);
    expect(light?.defaultBackground.value).toBe(lightTerminalColors.defaultBackground);
    expect(light?.ansi16[15]?.value).toBe(lightTerminalColors.palette[15]);
  });

  it("normalizes uppercase colors and their canonical signature", () => {
    const uppercase = {
      ...darkTerminalColors,
      palette: darkTerminalColors.palette.map((value) => value.toUpperCase()),
      defaultForeground: darkTerminalColors.defaultForeground.toUpperCase(),
      defaultBackground: darkTerminalColors.defaultBackground.toUpperCase(),
    };
    const normalized = parseStationTerminalPaletteObservation(uppercase);
    const expected = parseStationTerminalPaletteObservation(darkTerminalColors);

    expect(normalized).toEqual(expected);
    expect(normalized).not.toBeNull();
    expect(expected).not.toBeNull();
    if (normalized !== null && expected !== null) {
      expect(stationTerminalPaletteObservationSignature(normalized)).toBe(
        stationTerminalPaletteObservationSignature(expected),
      );
    }
  });

  it("rejects null default foreground or background", () => {
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        defaultForeground: null,
      }),
    ).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        defaultBackground: null,
      }),
    ).toBeNull();
  });

  it("rejects missing or null ANSI entries", () => {
    const withNull = mutablePalette(darkTerminalColors);
    withNull[7] = null;
    const withMissing = mutablePalette(darkTerminalColors);
    delete withMissing[4];

    expect(
      parseStationTerminalPaletteObservation({ ...darkTerminalColors, palette: withNull }),
    ).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({ ...darkTerminalColors, palette: withMissing }),
    ).toBeNull();
  });

  it("rejects short and oversized palette arrays", () => {
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        palette: darkTerminalColors.palette.slice(0, 15),
      }),
    ).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        palette: [...darkTerminalColors.palette, darkTerminalColors.palette[0]],
      }),
    ).toBeNull();
  });

  it("rejects malformed defaults, ANSI entries, and known special colors", () => {
    const malformedPalette = mutablePalette(darkTerminalColors);
    malformedPalette[3] = malformedTerminalColors.defaultForeground;

    expect(parseStationTerminalPaletteObservation(malformedTerminalColors)).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        palette: malformedPalette,
      }),
    ).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({
        ...darkTerminalColors,
        cursorColor: malformedTerminalColors.defaultForeground,
      }),
    ).toBeNull();
  });

  it("rejects missing and unknown fields", () => {
    const missing = { ...darkTerminalColors } as Record<string, unknown>;
    delete missing.highlightForeground;

    expect(parseStationTerminalPaletteObservation(missing)).toBeNull();
    expect(
      parseStationTerminalPaletteObservation({ ...darkTerminalColors, unexpected: null }),
    ).toBeNull();
  });

  it("rejects the unsupported-terminal all-null response", () => {
    expect(parseStationTerminalPaletteObservation(unsupportedTerminalColors)).toBeNull();
  });
});
