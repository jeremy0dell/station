export type StationVtTheme = {
  foreground: string;
  background: string;
  /** The 16 base ANSI colors (indices 0-15 of the 256-color palette). */
  ansi16: readonly string[];
};

// VS Code dark terminal defaults: familiar, readable on Station's dark pane.
export const stationVtTheme: StationVtTheme = {
  foreground: "#d4d4d8",
  background: "#101316",
  ansi16: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ],
};

/**
 * Indices 0-15 come from the theme; 16-231 are the standard 6x6x6 color cube
 * and 232-255 the grayscale ramp, both fixed by the xterm-256 spec.
 */
export function buildVtPalette256(ansi16: readonly string[]): readonly string[] {
  const palette = [...ansi16];
  for (let index = 16; index < 232; index++) {
    const n = index - 16;
    const r = cubeLevel(Math.floor(n / 36));
    const g = cubeLevel(Math.floor(n / 6) % 6);
    const b = cubeLevel(n % 6);
    palette.push(rgbToHexColor((r << 16) | (g << 8) | b));
  }
  for (let index = 232; index < 256; index++) {
    const level = 8 + 10 * (index - 232);
    palette.push(rgbToHexColor((level << 16) | (level << 8) | level));
  }
  return palette;
}

export const stationVtPalette256: readonly string[] = buildVtPalette256(stationVtTheme.ansi16);

export function rgbToHexColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function cubeLevel(value: number): number {
  return value === 0 ? 0 : 55 + 40 * value;
}
