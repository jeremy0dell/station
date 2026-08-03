import { nativeStationTheme } from "./builtInTheme.js";
import {
  contrastRatio,
  STATION_TEXT_CONTRAST_RATIO,
} from "./terminalPalette/contrast.js";
import type { StationTerminalPaletteObservation } from "./terminalPalette/observation.js";
import { createTerminalPaletteTheme } from "./terminalPalette/theme.js";
import type {
  StationAppearanceContext,
  StationAppearancePreference,
  StationTheme,
} from "./types.js";

type ResolveStationThemeInput = Readonly<{
  context: StationAppearanceContext;
  preference: StationAppearancePreference;
  observation?: StationTerminalPaletteObservation | null;
}>;

/**
 * Resolves renderer-owned appearance policy before delegating valid embedded palette construction.
 * Native auto remains Station-owned; embedded auto adapts only from complete, readable evidence.
 */
export function resolveStationTheme(input: ResolveStationThemeInput): StationTheme {
  if (input.preference === "auto") {
    return resolveAutomaticStationTheme(input);
  }
  return unsupportedAppearancePreference(input.preference);
}

function unsupportedAppearancePreference(preference: never): never {
  throw new RangeError(`Unsupported Station appearance preference: ${String(preference)}.`);
}

function resolveAutomaticStationTheme(input: ResolveStationThemeInput): StationTheme {
  if (input.context === "native-workspace") {
    return nativeStationTheme;
  }

  const observation = input.observation;
  if (
    observation === undefined ||
    observation === null ||
    contrastRatio(observation.defaultForeground, observation.defaultBackground) <
      STATION_TEXT_CONTRAST_RATIO
  ) {
    // Whole-theme fallback prevents terminal surfaces from being mixed with unrelated Station roles.
    return nativeStationTheme;
  }

  return createTerminalPaletteTheme(observation);
}
