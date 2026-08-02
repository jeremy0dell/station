import { stationRgbValue, type StationTheme } from "../theme/index.js";

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

// Rest/expanded/attention/actionable remain separate roles so the active theme owns every morph endpoint.
export function dynamicStationButtonColors(theme: StationTheme): DynamicStationButtonColors {
  const resting = stationRgbValue(theme.island.resting);
  const expanded = stationRgbValue(theme.island.expanded);
  const attention = stationRgbValue(theme.island.attention);
  const actionable = stationRgbValue(theme.island.actionable);
  return {
    base: {
      collapsed: { border: resting, icon: resting, text: resting },
      expanded: { border: expanded, icon: expanded, text: expanded },
    },
    attention: {
      collapsed: { border: attention, icon: attention, text: attention },
      expanded: { border: actionable, icon: actionable, text: actionable },
    },
  };
}

export function stationButtonColors(
  theme: StationTheme,
  attention: boolean,
  expanded: boolean,
): StationButtonStateColors {
  const colors = dynamicStationButtonColors(theme);
  const group = attention ? colors.attention : colors.base;
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
