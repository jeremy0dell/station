// Station product-chrome theme. Shared dashboard-core code emits semantic
// color roles; OpenTUI render surfaces resolve them to hex here.
import type { RowColor } from "@station/dashboard-core";
import type { ProviderHealth } from "@station/contracts";

const PRIMITIVE_COLORS = {
  background: "#101316",
  hoverBackground: "#1f242b",
  foreground: "#e4e4e7",
  muted: "#9ca3af",
  red: "#f87171",
  yellow: "#fbbf24",
  green: "#4ade80",
  blue: "#60a5fa",
  cyan: "#22d3ee",
  purple: "#d2a8ff",
} as const;

const CHROME_COLORS = {
  menuBackground: "#15191e",
  activeRow: "#2f3842",
  border: "#5b6470",
  mutedBorder: "#3f4750",
  disabledForeground: "#7a828c",
  overlayBackdrop: "#000000",
  terminalSelectionBackground: "#264f78",
  pane: {
    primary: {
      active: PRIMITIVE_COLORS.blue,
      inactive: "#1d4ed8",
    },
    shellAccents: [
      { active: PRIMITIVE_COLORS.green, inactive: "#14532d" },
      { active: PRIMITIVE_COLORS.purple, inactive: "#581c87" },
      { active: PRIMITIVE_COLORS.yellow, inactive: "#713f12" },
      { active: PRIMITIVE_COLORS.cyan, inactive: "#164e63" },
    ],
  },
  welcomeButton: {
    background: "#1f2937",
    mutedBackground: PRIMITIVE_COLORS.background,
    hoverBackground: "#263142",
    shimmerBackground: "#4a6a8c",
    shimmerForeground: "#ffffff",
  },
} as const;

const STATE_COLORS = {
  success: PRIMITIVE_COLORS.green,
  warning: PRIMITIVE_COLORS.yellow,
  danger: PRIMITIVE_COLORS.red,
  attention: PRIMITIVE_COLORS.red,
  ready: PRIMITIVE_COLORS.green,
  unknown: PRIMITIVE_COLORS.yellow,
  merged: PRIMITIVE_COLORS.purple,
} as const;

export const STATION_COLORS = {
  primitives: PRIMITIVE_COLORS,
  chrome: CHROME_COLORS,
  state: STATE_COLORS,
  gray: PRIMITIVE_COLORS.muted,
  red: PRIMITIVE_COLORS.red,
  yellow: PRIMITIVE_COLORS.yellow,
  green: PRIMITIVE_COLORS.green,
  blue: PRIMITIVE_COLORS.blue,
  cyan: PRIMITIVE_COLORS.cyan,
  purple: PRIMITIVE_COLORS.purple,
  foreground: PRIMITIVE_COLORS.foreground,
  background: PRIMITIVE_COLORS.background,
  hoverBackground: PRIMITIVE_COLORS.hoverBackground,
  overlayBackdrop: CHROME_COLORS.overlayBackdrop,
} as const;

const ROW_COLOR_HEX: Record<RowColor, string> = {
  gray: STATION_COLORS.gray,
  red: STATION_COLORS.red,
  yellow: STATION_COLORS.yellow,
  green: STATION_COLORS.green,
  blue: STATION_COLORS.blue,
  cyan: STATION_COLORS.cyan,
  purple: STATION_COLORS.purple,
};

export function rowColorToHex(color: RowColor | undefined): string | undefined {
  return color === undefined ? undefined : ROW_COLOR_HEX[color];
}

const PROVIDER_HEALTH_STATUS_COLORS: Record<ProviderHealth["status"], string> = {
  healthy: STATION_COLORS.state.success,
  degraded: STATION_COLORS.state.warning,
  unavailable: STATION_COLORS.state.danger,
  unknown: STATION_COLORS.gray,
};

export function providerHealthStatusColor(
  status: ProviderHealth["status"] | undefined,
): string | undefined {
  return status === undefined ? undefined : PROVIDER_HEALTH_STATUS_COLORS[status];
}
