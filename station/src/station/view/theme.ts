// The single name -> hex resolver for the STATION view, and the one place in
// station/src (outside terminal/*) allowed to hold raw hex — enforced by
// tools/lint/check-no-raw-hex.mjs.
import type { ProviderHealth } from "@station/contracts";
import type { RowColor, ToastBorderColorName } from "@station/dashboard-core";

export const STATION_COLORS = {
  gray: "#9ca3af",
  red: "#f87171",
  yellow: "#fbbf24",
  green: "#4ade80",
  blue: "#60a5fa",
  cyan: "#22d3ee",
  purple: "#d2a8ff",
  foreground: "#e4e4e7",
  background: "#101316",
  hoverBackground: "#1f242b",
  overlayBackdrop: "#000000",
  hairline: "#20252c",
  frozenSurface: "#12161b",
} as const;

export function rowColorToHex(color: RowColor | undefined): string | undefined {
  switch (color) {
    case undefined:
      return undefined;
    case "gray":
      return STATION_COLORS.gray;
    case "red":
      return STATION_COLORS.red;
    case "yellow":
      return STATION_COLORS.yellow;
    case "green":
      return STATION_COLORS.green;
    case "blue":
      return STATION_COLORS.blue;
    case "purple":
      return STATION_COLORS.purple;
  }
}

export function toastBorderColorHex(name: ToastBorderColorName): string {
  if (name === "red") {
    return STATION_COLORS.red;
  }
  if (name === "gray") {
    return STATION_COLORS.gray;
  }
  return STATION_COLORS.green;
}

// Context-menu surface chrome.
export const MENU_COLORS = {
  surface: "#15191e",
  selected: "#2f3842",
  text: "#f4f4f5",
  disabledText: "#7a828c",
  danger: STATION_COLORS.red,
  borderText: "#5b6470",
} as const;

const PROVIDER_HEALTH_STATUS_COLORS: Record<ProviderHealth["status"], string> = {
  healthy: STATION_COLORS.green,
  degraded: STATION_COLORS.yellow,
  unavailable: STATION_COLORS.red,
  unknown: STATION_COLORS.gray,
};

export function providerHealthStatusColor(
  status: ProviderHealth["status"] | undefined,
): string | undefined {
  return status === undefined ? undefined : PROVIDER_HEALTH_STATUS_COLORS[status];
}
