import { describe, expect, it } from "bun:test";
import { nativeStationTheme, stationRgbValue } from "../../theme/index.js";
import { buildVtPalette256, rgbToHexColor } from "./palette.js";

describe("VT ANSI-256 palette", () => {
  it("passes the selected ANSI-16 roles through unchanged", () => {
    const ansi16 = nativeStationTheme.terminal.ansi16.map(stationRgbValue);
    expect(buildVtPalette256(ansi16).slice(0, 16)).toEqual(ansi16);
  });

  it("expands the fixed xterm cube and grayscale ramp", () => {
    const palette = buildVtPalette256(
      nativeStationTheme.terminal.ansi16.map(stationRgbValue),
    );
    expect(palette).toHaveLength(256);
    expect(palette[16]).toBe("#000000");
    expect(palette[21]).toBe("#0000ff");
    expect(palette[231]).toBe("#ffffff");
    expect(palette[232]).toBe("#080808");
    expect(palette[255]).toBe("#eeeeee");
  });

  it("converts packed RGB to padded lowercase hex", () => {
    expect(rgbToHexColor(0x01020a)).toBe("#01020a");
  });
});
