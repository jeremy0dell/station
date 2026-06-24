// THE single DECCKM arrow-key table. Several call sites previously re-encoded
// this byte-identical mapping (stationInput's CURSOR_KEY_BYTES, wheelForward's
// arrowKey, sequenceToTuiKey's NAMED_SEQUENCES, stationBindings' arrow tokens,
// and kittyToLegacy's keypad-arrow rows); all now read it from here. Only the
// lookup table lives here; each client keeps its own selector/shape (Map vs
// Record vs ternary) at the call site.
export type ArrowDirection = "up" | "down" | "left" | "right";

/** normal = CSI form (DECCKM off); application = SS3 form (DECCKM on). */
export const ARROW_KEYS = {
  up: { normal: "\x1b[A", application: "\x1bOA" },
  down: { normal: "\x1b[B", application: "\x1bOB" },
  right: { normal: "\x1b[C", application: "\x1bOC" },
  left: { normal: "\x1b[D", application: "\x1bOD" },
} as const satisfies Record<ArrowDirection, { normal: string; application: string }>;

/**
 * Bidirectional normalizer: either form (CSI or SS3) maps to its
 * {normal, application} pair, mirroring the previous CURSOR_KEY_BYTES Map.
 */
export function cursorKeyBytes(): Map<string, { normal: string; application: string }> {
  const map = new Map<string, { normal: string; application: string }>();
  for (const dir of Object.keys(ARROW_KEYS) as ArrowDirection[]) {
    const pair = ARROW_KEYS[dir];
    map.set(pair.normal, pair);
    map.set(pair.application, pair);
  }
  return map;
}
