import { RGBA, type ColorInput } from "@opentui/core";
import type { StationColor, StationOpaqueColor } from "./types.js";

/** Converts a Station rendering intent without collapsing indexed/default metadata to RGB. */
export function toOpenTuiColor(color: StationColor): ColorInput {
  switch (color.kind) {
    case "rgb":
      return color.value;
    case "indexed":
      return RGBA.fromIndex(color.index, color.snapshot.value);
    case "terminal-default":
      return color.channel === "foreground"
        ? RGBA.defaultForeground(color.snapshot.value)
        : RGBA.defaultBackground(color.snapshot.value);
    case "alpha": {
      const value = RGBA.fromHex(color.color.value);
      value.a = color.alpha;
      return value;
    }
  }
}

/** Opaque-role adapter whose input type rejects alpha rendering intent. */
export function toOpenTuiOpaqueColor(color: StationOpaqueColor): ColorInput {
  return toOpenTuiColor(color);
}
