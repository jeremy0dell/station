import { describe, expect, it } from "bun:test";
import { embeddedStationTheme, nativeStationTheme } from "./builtInTheme.js";
import { stationRgbValue } from "./openTuiColor.js";
import type { StationTheme } from "./types.js";

function expectCompleteTheme(theme: StationTheme): void {
  expect(Object.keys(theme.surfaces).sort()).toEqual([
    "canvas",
    "frozen",
    "help",
    "overlay",
    "panel",
    "prompt",
    "settings",
    "sheet",
    "toast",
  ]);
  expect(Object.keys(theme.text).sort()).toEqual([
    "disabled",
    "inverse",
    "menu",
    "muted",
    "primary",
  ]);
  expect(Object.keys(theme.status).sort()).toEqual([
    "accent",
    "danger",
    "info",
    "neutral",
    "success",
    "warning",
    "working",
  ]);
  expect(Object.keys(theme.action).sort()).toEqual(["danger", "primary", "success", "warning"]);
  expect(Object.keys(theme.interaction).sort()).toEqual([
    "border",
    "compactFocus",
    "hairline",
    "hover",
    "keyboardFocus",
    "overlay",
  ]);
  expect(Object.keys(theme.welcome).sort()).toEqual([
    "border",
    "borderActive",
    "button",
    "buttonHover",
    "buttonMuted",
    "muted",
    "shimmer",
    "shimmerPeak",
    "wordmark",
  ]);
  expect(Object.keys(theme.contextMenu).sort()).toEqual(["border", "selected", "surface"]);
  expect(Object.keys(theme.island).sort()).toEqual([
    "actionable",
    "attention",
    "background",
    "expanded",
    "resting",
  ]);
  expect(theme.pane.shells).toHaveLength(4);
  expect(theme.terminal.ansi16).toHaveLength(16);
}

describe("built-in Station themes", () => {
  it("implements every semantic role in both renderer variants", () => {
    expectCompleteTheme(nativeStationTheme);
    expectCompleteTheme(embeddedStationTheme);
  });

  it("retains the native Station-dark RGB roles", () => {
    expect(stationRgbValue(nativeStationTheme.surfaces.canvas)).toBe("#101316");
    expect(stationRgbValue(nativeStationTheme.text.primary)).toBe("#e4e4e7");
    expect(stationRgbValue(nativeStationTheme.text.muted)).toBe("#9ca3af");
    expect(stationRgbValue(nativeStationTheme.interaction.hover)).toBe("#1f242b");
    expect(stationRgbValue(nativeStationTheme.interaction.keyboardFocus)).toBe("#15222e");
    expect(stationRgbValue(nativeStationTheme.interaction.compactFocus)).toBe("#1b3448");
  });

  it("keeps embedded surfaces terminal-default with the Station-dark fallback", () => {
    for (const role of [
      embeddedStationTheme.surfaces.canvas,
      embeddedStationTheme.surfaces.panel,
      embeddedStationTheme.surfaces.prompt,
      embeddedStationTheme.surfaces.help,
      embeddedStationTheme.surfaces.sheet,
      embeddedStationTheme.surfaces.settings,
      embeddedStationTheme.surfaces.toast,
    ]) {
      expect(role.kind).toBe("terminal-default");
      if (role.kind === "terminal-default") {
        expect(role.channel).toBe("background");
        expect(stationRgbValue(role.fallback)).toBe("#101316");
      }
    }
  });

  it("retains terminal defaults and ANSI-16 output", () => {
    expect(stationRgbValue(nativeStationTheme.terminal.defaultForeground)).toBe("#d4d4d8");
    expect(stationRgbValue(nativeStationTheme.terminal.defaultBackground)).toBe("#101316");
    expect(nativeStationTheme.terminal.ansi16.map(stationRgbValue)).toEqual([
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
    ]);
  });
});
