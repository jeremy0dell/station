import { STATION_COLORS } from "../station/view/theme.js";

// Themeable color tokens for the station button. border/icon/text are separate
// tokens though equal per state, so a theme can diverge them later.
export type StationButtonStateColors = {
  border: string;
  icon: string;
  text: string;
};

export type DynamicStationButtonColors = {
  base: { collapsed: StationButtonStateColors; expanded: StationButtonStateColors };
  attention: { collapsed: StationButtonStateColors; expanded: StationButtonStateColors };
};

// green=rest, blue=expanded, red=alert, purple=actionable; the hover morph
// lerps between the resting and expanded roles.
const GREEN = STATION_COLORS.green;
const BLUE = STATION_COLORS.blue;
const RED = STATION_COLORS.red;
const PURPLE = STATION_COLORS.purple;

export const dynamicStationButtonColors: DynamicStationButtonColors = {
  base: {
    collapsed: { border: GREEN, icon: GREEN, text: GREEN },
    expanded: { border: BLUE, icon: BLUE, text: BLUE },
  },
  attention: {
    collapsed: { border: RED, icon: RED, text: RED },
    expanded: { border: PURPLE, icon: PURPLE, text: PURPLE },
  },
};

export function stationButtonColors(
  attention: boolean,
  expanded: boolean,
): StationButtonStateColors {
  const group = attention ? dynamicStationButtonColors.attention : dynamicStationButtonColors.base;
  return expanded ? group.expanded : group.collapsed;
}

// Interpolate between two #rrggbb colors. Continuous (24-bit), so it animates
// smoothly even while the integer-cell box size steps.
export function lerpColor(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const channel = (i: number): number => {
    const v = Math.round(a[i] + (b[i] - a[i]) * t);
    return Math.min(255, Math.max(0, v)); // clamp so an out-of-range t can't emit bad hex
  };
  return `#${hex(channel(0))}${hex(channel(1))}${hex(channel(2))}`;
}

function parseHex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function hex(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}
