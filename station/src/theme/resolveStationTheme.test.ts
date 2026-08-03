import { describe, expect, it } from "bun:test";
import { nativeStationTheme } from "./builtInTheme.js";
import { resolveStationTheme } from "./resolveStationTheme.js";
import { parseStationTerminalPaletteObservation } from "./terminalPalette/observation.js";
import {
  darkTerminalColors,
  lowContrastTerminalColors,
} from "./terminalPalette/test/fixtures.js";

function observation(value: unknown) {
  const parsed = parseStationTerminalPaletteObservation(value);
  if (parsed === null) {
    throw new Error("Expected a complete terminal palette fixture.");
  }
  return parsed;
}

describe("Station theme resolution policy", () => {
  it("keeps native auto on the exact built-in object", () => {
    expect(
      resolveStationTheme({ context: "native-workspace", preference: "auto" }),
    ).toBe(nativeStationTheme);
  });

  it("delegates valid embedded evidence to terminal palette construction", () => {
    const observed = observation(darkTerminalColors);
    const theme = resolveStationTheme({
      context: "embedded-dashboard",
      preference: "auto",
      observation: observed,
    });

    expect(theme).not.toBe(nativeStationTheme);
    expect(theme.terminal).toBe(observed);
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
});
