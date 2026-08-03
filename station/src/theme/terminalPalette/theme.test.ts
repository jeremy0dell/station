import { describe, expect, it } from "bun:test";
import { stationColorSnapshot, type StationColor, type StationTheme } from "../types.js";
import { contrastRatio, STATION_TEXT_CONTRAST_RATIO } from "./contrast.js";
import { parseStationTerminalPaletteObservation } from "./observation.js";
import {
  darkTerminalColors,
  lightTerminalColors,
  veryDarkTerminalColors,
  veryLightTerminalColors,
  weakAnsiTerminalColors,
} from "./test/fixtures.js";
import { createTerminalPaletteTheme, terminalPalettePolarity } from "./theme.js";

function observation(value: unknown) {
  const parsed = parseStationTerminalPaletteObservation(value);
  if (parsed === null) {
    throw new Error("Expected a complete terminal palette fixture.");
  }
  return parsed;
}

function terminalTheme(value: unknown): StationTheme {
  return createTerminalPaletteTheme(observation(value));
}

function contrast(first: StationColor, second: StationColor): number {
  return contrastRatio(stationColorSnapshot(first), stationColorSnapshot(second));
}

describe("terminal palette theme construction", () => {
  it("classifies palette polarity from observed default luminance", () => {
    expect(terminalPalettePolarity(observation(darkTerminalColors))).toBe("dark");
    expect(terminalPalettePolarity(observation(lightTerminalColors))).toBe("light");
  });

  it("resolves complete dark and light terminal themes", () => {
    for (const fixture of [darkTerminalColors, lightTerminalColors]) {
      const theme = terminalTheme(fixture);
      expect(theme.surfaces.canvas).toMatchObject({
        kind: "terminal-default",
        channel: "background",
      });
      expect(theme.text.primary).toMatchObject({
        kind: "terminal-default",
        channel: "foreground",
      });
      expect(contrast(theme.text.primary, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
        STATION_TEXT_CONTRAST_RATIO,
      );
      expect(theme.pane.shells).toHaveLength(4);
    }
  });

  it("derives stable themes for very dark and very light observations", () => {
    const dark = terminalTheme(veryDarkTerminalColors);
    const light = terminalTheme(veryLightTerminalColors);

    expect(stationColorSnapshot(dark.interaction.hover)).not.toEqual(
      stationColorSnapshot(light.interaction.hover),
    );
    expect(contrast(dark.text.muted, dark.surfaces.canvas)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
    expect(contrast(light.text.muted, light.surfaces.canvas)).toBeGreaterThanOrEqual(
      STATION_TEXT_CONTRAST_RATIO,
    );
  });

  it("corrects weak ANSI colors to explicit RGB", () => {
    const theme = terminalTheme(weakAnsiTerminalColors);

    for (const color of [
      theme.status.danger,
      theme.status.warning,
      theme.status.success,
      theme.status.working,
      theme.action.primary,
    ]) {
      expect(color.kind).toBe("rgb");
      expect(contrast(color, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
        STATION_TEXT_CONTRAST_RATIO,
      );
    }
  });

  it("retains indexed intent and exact snapshots for safe ANSI colors", () => {
    const observed = observation(darkTerminalColors);
    const theme = createTerminalPaletteTheme(observed);

    expect(theme.status.danger).toEqual({
      kind: "indexed",
      index: 9,
      snapshot: observed.ansi16[9],
    });
    expect(theme.action.primary).toEqual({
      kind: "indexed",
      index: 14,
      snapshot: observed.ansi16[14],
    });
  });

  it("retains terminal-default channel intent and observed snapshots", () => {
    const observed = observation(lightTerminalColors);
    const theme = createTerminalPaletteTheme(observed);

    expect(theme.text.primary).toEqual({
      kind: "terminal-default",
      channel: "foreground",
      snapshot: observed.defaultForeground,
    });
    expect(theme.surfaces.canvas).toEqual({
      kind: "terminal-default",
      channel: "background",
      snapshot: observed.defaultBackground,
    });
  });

  it("populates every semantic role without alpha intent", () => {
    const theme = terminalTheme(lightTerminalColors);
    const serialized = JSON.stringify(theme);

    expect(serialized).not.toContain("null");
    expect(serialized).not.toContain('"kind":"alpha"');
    expect(Object.values(theme.surfaces)).toHaveLength(7);
    expect(Object.values(theme.text)).toHaveLength(5);
    expect(Object.values(theme.status)).toHaveLength(7);
    expect(Object.values(theme.action)).toHaveLength(4);
    expect(Object.values(theme.interaction)).toHaveLength(5);
    expect(Object.values(theme.welcome)).toHaveLength(9);
    expect(Object.values(theme.contextMenu)).toHaveLength(3);
    expect(Object.values(theme.island)).toHaveLength(5);
  });

  it("keeps every opaque role free of alpha intent", () => {
    const theme = terminalTheme(darkTerminalColors);
    const opaqueRoles = [
      ...Object.values(theme.surfaces),
      theme.interaction.hover,
      theme.interaction.keyboardFocus,
      theme.interaction.compactFocus,
      theme.welcome.button,
      theme.welcome.buttonMuted,
      theme.welcome.buttonHover,
      theme.contextMenu.surface,
      theme.contextMenu.selected,
      theme.island.background,
      theme.pane.selection,
    ];

    expect(opaqueRoles.map((color) => color.kind)).not.toContain("alpha");
  });

  it("retains the exact normalized terminal observation", () => {
    const observed = observation(darkTerminalColors);
    const theme = createTerminalPaletteTheme(observed);

    expect(theme.terminal).toBe(observed);
  });

  it("is deterministic across repeated construction", () => {
    const observed = observation(lightTerminalColors);

    expect(createTerminalPaletteTheme(observed)).toEqual(createTerminalPaletteTheme(observed));
  });
});
