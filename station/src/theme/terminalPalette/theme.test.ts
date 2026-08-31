import { describe, expect, it } from "bun:test";
import { convert, hexToRGB, OKLCH, sRGB } from "@texel/color";
import { nativeStationTheme } from "../builtInTheme.js";
import { stationColorSnapshot, type StationColor, type StationTheme } from "../types.js";
import { contrastRatio, STATION_BOUNDARY_CONTRAST_RATIO, STATION_TEXT_CONTRAST_RATIO } from "./contrast.js";
import { parseStationTerminalPaletteObservation } from "./observation.js";
import {
  darkTerminalColors,
  grayTerminalColors,
  lightTerminalColors,
  lowContrastTerminalColors,
  nearWhiteTerminalColors,
  saturatedDarkTerminalColors,
  saturatedLightTerminalColors,
  veryDarkTerminalColors,
  veryLightTerminalColors,
  weakAnsiLightTerminalColors,
  weakAnsiTerminalColors,
} from "./test/fixtures.js";
import {
  createTerminalPaletteTheme,
  resolveEmbeddedStationTheme,
  terminalPalettePolarity,
} from "./theme.js";

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

function oklchOf(color: StationColor): [number, number, number] {
  const value = convert(hexToRGB(stationColorSnapshot(color).value), sRGB, OKLCH);
  return [value[0], value[1], value[2]];
}

function hueDistance(first: number, second: number): number {
  const difference = Math.abs(first - second) % 360;
  return Math.min(difference, 360 - difference);
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

  it("selects one whole fallback for absent or unreadable embedded evidence", () => {
    const fallback = resolveEmbeddedStationTheme(null);

    expect(resolveEmbeddedStationTheme(undefined)).toBe(fallback);
    expect(
      resolveEmbeddedStationTheme(observation(lowContrastTerminalColors)),
    ).toBe(fallback);
    expect(fallback.surfaces.canvas).toMatchObject({
      kind: "terminal-default",
      channel: "background",
    });
    expect(fallback.text.primary).toMatchObject({
      kind: "terminal-default",
      channel: "foreground",
    });
  });

  it("guards direct construction against unreadable default contrast", () => {
    expect(createTerminalPaletteTheme(observation(lowContrastTerminalColors))).toBe(
      resolveEmbeddedStationTheme(null),
    );
  });

  it("derives a terminal theme only from complete readable embedded evidence", () => {
    const observed = observation(darkTerminalColors);
    const theme = resolveEmbeddedStationTheme(observed);

    expect(theme).not.toBe(nativeStationTheme);
    expect(theme.terminal).toBe(observed);
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

  it("keeps ordinary foreground roles readable on every interaction surface", () => {
    for (const fixture of [
      darkTerminalColors,
      lightTerminalColors,
      nearWhiteTerminalColors,
      weakAnsiLightTerminalColors,
      saturatedLightTerminalColors,
      saturatedDarkTerminalColors,
    ]) {
      const theme = terminalTheme(fixture);
      const foregrounds = [
        theme.text.primary,
        theme.text.muted,
        ...Object.values(theme.status),
        ...Object.values(theme.action),
      ];
      const surfaces = [
        theme.interaction.hover,
        theme.interaction.keyboardFocus,
        theme.interaction.compactFocus,
        theme.filter.editorSurface,
        theme.filter.appliedSurface,
      ];

      for (const surface of surfaces) {
        for (const foreground of foregrounds) {
          expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(
            STATION_TEXT_CONTRAST_RATIO,
          );
        }
      }
    }
  });

  it("keeps adaptive filter role pairs readable", () => {
    for (const fixture of [darkTerminalColors, lightTerminalColors]) {
      const theme = terminalTheme(fixture);
      const pairs = [
        [theme.filter.editorRail, theme.filter.editorSurface],
        [theme.filter.zeroMatch, theme.filter.editorSurface],
        [theme.text.inverse, theme.filter.editorRail],
        [theme.filter.matchForeground, theme.filter.matchBackground],
      ] as const;

      for (const [foreground, background] of pairs) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(
          STATION_TEXT_CONTRAST_RATIO,
        );
      }
    }
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

  it("keeps layered surfaces distinct from the canvas and each other", () => {
    for (const fixture of [
      lightTerminalColors,
      nearWhiteTerminalColors,
      veryLightTerminalColors,
      veryDarkTerminalColors,
    ]) {
      const theme = terminalTheme(fixture);
      const layered = [
        theme.surfaces.canvas,
        theme.interaction.hover,
        theme.interaction.keyboardFocus,
        theme.interaction.compactFocus,
        theme.contextMenu.selected,
      ];

      for (let first = 0; first < layered.length; first += 1) {
        for (let second = first + 1; second < layered.length; second += 1) {
          expect(contrast(layered[first], layered[second])).toBeGreaterThan(1.1);
        }
      }
    }
  });

  it("preserves hue and chroma when repairing weak light ANSI accents", () => {
    const observed = observation(weakAnsiLightTerminalColors);
    const theme = terminalTheme(weakAnsiLightTerminalColors);
    const roles = [
      ["danger", 9],
      ["success", 10],
      ["warning", 11],
      ["working", 12],
      ["accent", 13],
      ["info", 14],
    ] as const;

    for (const [role, index] of roles) {
      const color = theme.status[role];
      const source = oklchOf(observed.ansi16[index]);
      const corrected = oklchOf(color);

      expect(color.kind).toBe("rgb");
      expect(contrast(color, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
        STATION_TEXT_CONTRAST_RATIO,
      );
      expect(hueDistance(corrected[2], source[2])).toBeLessThan(6);
      expect(corrected[1]).toBeGreaterThanOrEqual(0.6 * source[1]);
    }
  });

  it("repairs saturated accents without collapsing onto the foreground", () => {
    for (const fixture of [
      saturatedLightTerminalColors,
      saturatedDarkTerminalColors,
    ]) {
      const observed = observation(fixture);
      const theme = terminalTheme(fixture);
      const primary = stationColorSnapshot(theme.text.primary).value;
      const roles = [
        ["danger", 9],
        ["success", 10],
        ["warning", 11],
        ["working", 12],
        ["accent", 13],
        ["info", 14],
      ] as const;

      for (const [role, index] of roles) {
        const color = theme.status[role];
        const source = oklchOf(observed.ansi16[index]);
        const corrected = oklchOf(color);

        expect(contrast(color, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
          STATION_TEXT_CONTRAST_RATIO,
        );
        if (color.kind === "rgb") {
          // Out-of-gamut hues must hold their searched lightness and hue instead
          // of drifting toward the hue's cusp and collapsing to the foreground.
          expect(stationColorSnapshot(color).value).not.toBe(primary);
          expect(hueDistance(corrected[2], source[2])).toBeLessThan(6);
          expect(corrected[1]).toBeGreaterThanOrEqual(0.5 * source[1]);
        } else {
          expect(corrected[2]).toBe(source[2]);
          expect(corrected[1]).toBe(source[1]);
        }
      }
    }
  });

  it("keeps chromatic status roles recognizably distinct", () => {
    for (const fixture of [
      darkTerminalColors,
      lightTerminalColors,
      nearWhiteTerminalColors,
      weakAnsiLightTerminalColors,
      saturatedLightTerminalColors,
      saturatedDarkTerminalColors,
    ]) {
      const theme = terminalTheme(fixture);
      const hues = ["danger", "warning", "success", "working", "info", "accent"] as const;
      const roleHues = hues.map((role) => oklchOf(theme.status[role])[2]);
      let minimumDistance = 360;
      for (let first = 0; first < roleHues.length; first += 1) {
        for (let second = first + 1; second < roleHues.length; second += 1) {
          minimumDistance = Math.min(
            minimumDistance,
            hueDistance(roleHues[first], roleHues[second]),
          );
        }
      }

      expect(minimumDistance).toBeGreaterThanOrEqual(30);
    }
  });

  it("resolves a readable, deterministic theme from a chroma-less gray palette", () => {
    const theme = terminalTheme(grayTerminalColors);
    const repeated = terminalTheme(grayTerminalColors);

    // A fully neutral palette affords no hue separation; every corrected role
    // converges on the same readable gray. Contrast floors still hold.
    for (const color of Object.values(theme.status)) {
      expect(color.kind).toBe("rgb");
      expect(contrast(color, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
        STATION_TEXT_CONTRAST_RATIO,
      );
    }
    const roleValues = Object.values(theme.status).map((color) =>
      stationColorSnapshot(color).value,
    );
    expect(new Set(roleValues)).toHaveLength(1);
    expect(theme).toEqual(repeated);
  });

  it("keeps pane accents and their inactive fills distinct on light palettes", () => {
    const theme = terminalTheme(lightTerminalColors);
    const pairs = [
      [theme.pane.primary.active, theme.pane.primary.inactive],
      [theme.pane.shells[0].active, theme.pane.shells[0].inactive],
    ] as const;

    for (const [active, inactive] of pairs) {
      expect(stationColorSnapshot(inactive)).not.toEqual(stationColorSnapshot(active));
      expect(contrast(inactive, theme.surfaces.canvas)).toBeGreaterThanOrEqual(
        STATION_BOUNDARY_CONTRAST_RATIO,
      );
      expect(contrast(active, inactive)).toBeGreaterThan(1.1);
    }
  });

  it("retains indexed intent and exact snapshots for safe ANSI colors", () => {
    const observed = observation(darkTerminalColors);
    const theme = createTerminalPaletteTheme(observed);

    expect(theme.status.warning).toEqual({
      kind: "indexed",
      index: 11,
      snapshot: observed.ansi16[11],
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

  it("populates every semantic role and limits alpha intent to the modal backdrop", () => {
    const theme = terminalTheme(lightTerminalColors);
    const { conditionBackdrop, ...opaqueFilter } = theme.filter;
    const serialized = JSON.stringify({ ...theme, filter: opaqueFilter });

    expect(serialized).not.toContain("null");
    expect(serialized).not.toContain('"kind":"alpha"');
    expect(conditionBackdrop.kind).toBe("alpha");
    expect(Object.values(theme.surfaces)).toHaveLength(7);
    expect(Object.values(theme.text)).toHaveLength(5);
    expect(Object.values(theme.status)).toHaveLength(7);
    expect(Object.values(theme.action)).toHaveLength(4);
    expect(Object.values(theme.interaction)).toHaveLength(5);
    expect(Object.values(theme.filter)).toHaveLength(9);
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
      theme.filter.editorSurface,
      theme.filter.appliedSurface,
      theme.filter.matchBackground,
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
