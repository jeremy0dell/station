import type { ProviderHealth } from "@station/contracts";
import type { RowColor, ToastBorderColorName } from "@station/dashboard-core";
import type { StationRgbColor, StationTheme } from "./types.js";

export { embeddedStationTheme, nativeStationTheme } from "./builtInTheme.js";
export {
  stationRgbValue,
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
} from "./openTuiColor.js";
export {
  EmbeddedStationThemeProvider,
  NativeStationThemeProvider,
  StationThemeProvider,
  useStationTheme,
} from "./themeContext.js";
export {
  alphaColor,
  indexedColor,
  rgbColor,
  terminalDefaultColor,
} from "./types.js";
export type {
  StationAlphaColor,
  StationColor,
  StationIndexedColor,
  StationOpaqueColor,
  StationPaneAccent,
  StationRgbColor,
  StationTerminalDefaultColor,
  StationTerminalTheme,
  StationTheme,
} from "./types.js";

/** Resolves dashboard-core's renderer-neutral row label through semantic theme roles. */
export function rowColor(theme: StationTheme, color: RowColor | undefined): StationRgbColor | undefined {
  switch (color) {
    case undefined:
      return undefined;
    case "gray":
      return theme.status.neutral;
    case "red":
      return theme.status.danger;
    case "yellow":
      return theme.status.warning;
    case "green":
      return theme.status.success;
    case "blue":
      return theme.status.working;
    case "cyan":
      return theme.action.primary;
    case "purple":
      return theme.status.accent;
  }
}

/** Resolves dashboard-core toast border names without giving core concrete colors. */
export function toastBorderColor(
  theme: StationTheme,
  name: ToastBorderColorName,
): StationRgbColor {
  switch (name) {
    case "red":
      return theme.status.danger;
    case "gray":
      return theme.status.neutral;
    case "green":
      return theme.status.success;
  }
}

/** Resolves normalized provider-health status through Station's status roles. */
export function providerHealthColor(
  theme: StationTheme,
  status: ProviderHealth["status"],
): StationRgbColor;
export function providerHealthColor(theme: StationTheme, status: undefined): undefined;
export function providerHealthColor(
  theme: StationTheme,
  status: ProviderHealth["status"] | undefined,
): StationRgbColor | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case "healthy":
      return theme.status.success;
    case "degraded":
      return theme.status.warning;
    case "unavailable":
      return theme.status.danger;
    case "unknown":
      return theme.status.neutral;
  }
}
