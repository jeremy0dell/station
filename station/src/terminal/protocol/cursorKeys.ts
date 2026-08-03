import { VtPrefix } from "./syntax.js";

// THE single DECCKM arrow-key table. Several call sites previously re-encoded
// this byte-identical mapping (stationInput's CURSOR_KEY_BYTES, wheelForward's
// arrowKey, sequenceToTuiKey's NAMED_SEQUENCES, stationBindings' arrow tokens,
// and kittyToLegacy's keypad-arrow rows); all now read it from here. Only the
// lookup tables live here; each client keeps its own selector at the call site.
export type ArrowDirection = "up" | "down" | "left" | "right";

/** normal = CSI form (DECCKM off); application = SS3 form (DECCKM on). */
export const ARROW_KEYS = {
  up: { normal: `${VtPrefix.Csi}A`, application: `${VtPrefix.Ss3}A` },
  down: { normal: `${VtPrefix.Csi}B`, application: `${VtPrefix.Ss3}B` },
  right: { normal: `${VtPrefix.Csi}C`, application: `${VtPrefix.Ss3}C` },
  left: { normal: `${VtPrefix.Csi}D`, application: `${VtPrefix.Ss3}D` },
} as const satisfies Record<ArrowDirection, { normal: string; application: string }>;

/** Either wire form mapped to the shared normal/application pair. */
export const CURSOR_KEY_BYTES = new Map<string, { normal: string; application: string }>(
  Object.values(ARROW_KEYS).flatMap((pair) => [
    [pair.normal, pair] as const,
    [pair.application, pair] as const,
  ]),
);
