/**
 * Builds ANSI-256 values: theme-owned ANSI 0-15 plus the fixed xterm cube and grayscale ramp.
 */
export function buildVtPalette256(ansi16: readonly string[]): readonly string[] {
  if (ansi16.length !== 16) {
    throw new RangeError(`ANSI-16 palette must contain exactly 16 colors, got ${ansi16.length}.`);
  }
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

export function rgbToHexColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function cubeLevel(value: number): number {
  return value === 0 ? 0 : 55 + 40 * value;
}
