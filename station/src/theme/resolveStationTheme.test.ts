import { describe, expect, it } from "bun:test";
import { nativeStationTheme } from "./builtInTheme.js";
import { resolveStationTheme, STATION_TEXT_CONTRAST_RATIO } from "./resolveStationTheme.js";
import { parseStationTerminalPaletteObservation } from "./terminalPaletteObservation.js";
import {
  darkTerminalColors,
  lightTerminalColors,
  lowContrastTerminalColors,
  veryDarkTerminalColors,
  veryLightTerminalColors,
  weakAnsiTerminalColors,
} from "./test/terminalPaletteFixtures.js";
import { stationColorSnapshot, type StationColor, type StationTheme } from "./types.js";

function observation(value: unknown) {
  const parsed = parseStationTerminalPaletteObservation(value);
  if (parsed === null) {
    throw new Error("Expected a complete terminal palette fixture.");
  }
  return parsed;
}

function embeddedTheme(value: unknown): StationTheme {
  return resolveStationTheme({
    context: "embedded-dashboard",
    preference: "auto",
    observation: observation(value),
  });
}

function contrast(first: StationColor, second: StationColor): number {
  const luminance = (color: StationColor): number => {
    const value = stationColorSnapshot(color).value;
    const channels = [value.slice(1, 3), value.slice(3, 5), value.slice(5, 7)].map((part) => {
      const channel = Number.parseInt(part, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe("adaptive Station theme resolver", () => {
  it("keeps native auto on the exact built-in object", () => {
    expect(
      resolveStationTheme({ context: "native-workspace", preference: "auto" }),
    ).toBe(nativeStationTheme);
  });

  it("resolves complete dark and light terminal themes", () => {
    for (const fixture of [darkTerminalColors, lightTerminalColors]) {
      const theme = embeddedTheme(fixture);
      expect(theme).not.toBe(nativeStationTheme);
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
    const dark = embeddedTheme(veryDarkTerminalColors);
    const light = embeddedTheme(veryLightTerminalColors);

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

  it("selects the whole native fallback when observation is absent", () => {
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
    });

    expect(theme).toBe(nativeStationTheme);
    expect(theme.surfaces.canvas.kind).toBe("rgb");
  });

  it("selects the whole native fallback for a low-contrast default pair", () => {
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
      observation: observation(lowContrastTerminalColors),
    });

    expect(theme).toBe(nativeStationTheme);
  });

  it("corrects weak ANSI colors to explicit RGB", () => {
    const theme = embeddedTheme(weakAnsiTerminalColors);

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
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
      observation: observed,
    });

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
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
      observation: observed,
    });

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
    const theme = embeddedTheme(lightTerminalColors);
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
    const theme = embeddedTheme(darkTerminalColors);
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
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
      observation: observed,
    });

    expect(theme.terminal).toBe(observed);
  });

  it("is deterministic across repeated resolution", () => {
    const observed = observation(lightTerminalColors);
    const input = {
      context: "embedded-dashboard" as const,
      preference: "auto" as const,
      observation: observed,
    };

    expect(resolveStationTheme(input)).toEqual(resolveStationTheme(input));
  });
});
