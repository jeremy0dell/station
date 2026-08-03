// Named control-byte / prefix constants so raw \x1b and \x1b[ stop appearing
// inline as bare bytes; character-class uses (as in `terminalReplies.ts`) still
// spell the escape inline where a prefix constant cannot substitute.
export const ControlByte = {
  /** BEL (0x07). */
  Bel: "\x07",
  /** ESC (0x1b). */
  Esc: "\x1b",
  /** CSI prefix (ESC [). */
  Csi: "\x1b[",
} as const;

export const CsiFinal = {
  /** ED — Erase in Display (CSI Ps J). */
  EraseInDisplay: "J",
  /** ECH — Erase Character (CSI Ps X). */
  EraseCharacter: "X",
} as const;

export const EraseInDisplayMode = {
  /** ED2 — erase the entire display. */
  EntireDisplay: 2,
} as const;

