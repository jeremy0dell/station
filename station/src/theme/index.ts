import type { ProviderHealth } from "@station/contracts";
import type { RowColor, ToastBorderColorName } from "@station/dashboard-core";
import type { StationSemanticColor, StationTheme } from "./types.js";

export { nativeStationTheme } from "./builtInTheme.js";
export { toOpenTuiColor, toOpenTuiOpaqueColor } from "./openTuiColor.js";
export { createStationThemeController } from "./terminalPalette/controller.js";
export type { StationThemeController } from "./terminalPalette/controller.js";
export {
  StationThemeProvider,
  useStationTheme,
  useStationThemeSource,
} from "./themeContext.js";
export type { StationThemeSource } from "./themeContext.js";
export { rgbColor, stationColorSnapshotValue } from "./types.js";
export type {
  StationColor,
  StationForegroundColor,
  StationSemanticColor,
  StationTerminalTheme,
  StationTheme,
} from "./types.js";

/** Resolves dashboard-core's renderer-neutral row label through semantic theme roles. */
export function rowColor(
  theme: StationTheme,
  color: RowColor | undefined,
): StationSemanticColor | undefined {
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
): StationSemanticColor {
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
): StationSemanticColor;
export function providerHealthColor(theme: StationTheme, status: undefined): undefined;
export function providerHealthColor(
  theme: StationTheme,
  status: ProviderHealth["status"] | undefined,
): StationSemanticColor | undefined {
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
