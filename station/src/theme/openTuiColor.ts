import { RGBA, type ColorInput } from "@opentui/core";
import type {
  StationColor,
  StationOpaqueColor,
  StationRgbColor,
} from "./types.js";

/** Converts a Station rendering intent without collapsing indexed/default metadata to RGB. */
export function toOpenTuiColor(color: StationColor): ColorInput {
  switch (color.kind) {
    case "rgb":
      return color.value;
    case "indexed":
      return RGBA.fromIndex(color.index);
    case "terminal-default":
      return color.channel === "foreground"
        ? RGBA.defaultForeground(color.fallback.value)
        : RGBA.defaultBackground(color.fallback.value);
    case "alpha": {
      const value = RGBA.fromHex(color.color.value);
      value.a = Math.max(0, Math.min(1, color.alpha));
      return value;
    }
  }
}

/** Opaque-role adapter whose input type rejects alpha rendering intent. */
export function toOpenTuiOpaqueColor(color: StationOpaqueColor): ColorInput {
  return toOpenTuiColor(color);
}

/** Returns the stable RGB value carried by an explicit RGB theme role. */
export function stationRgbValue(color: StationRgbColor): string {
  return color.value;
}
