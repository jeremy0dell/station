// Ink color-name -> hex tokens for the STATION view. The shared layout speaks
// Ink's named RowColor vocabulary (plus the literal purple hex); OpenTUI
// takes fg hex strings. Values match the terminal-ish palette the rest of
// Station already uses.
import { ROW_COLOR_PURPLE, type RowColor } from "@station/dashboard-core";

export const STATION_COLORS = {
  gray: "#9ca3af",
  red: "#f87171",
  yellow: "#fbbf24",
  green: "#4ade80",
  blue: "#60a5fa",
  cyan: "#22d3ee",
  purple: ROW_COLOR_PURPLE,
  foreground: "#e4e4e7",
  background: "#101316",
  hoverBackground: "#1f242b",
  overlayBackdrop: "#000000",
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
    default:
      // ROW_COLOR_PURPLE is already a hex literal.
      return color;
  }
}
