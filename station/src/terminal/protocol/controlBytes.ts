// Named control-byte / prefix constants so raw \x1b and \x1b[ stop appearing
// inline as bare bytes. ControlBytePattern carries the regex-source escapes of
// the same prefixes; character-class uses (as in `terminalReplies.ts`) still
// spell the escape inline where a prefix constant cannot substitute.
export const ControlByte = {
  /** ESC (0x1b). */
  Esc: "\x1b",
  /** CSI prefix (ESC [). */
  Csi: "\x1b[",
} as const;

export const CsiFinal = {
  /** ED — Erase in Display (CSI Ps J). */
  EraseInDisplay: "J",
} as const;

export const EraseInDisplayMode = {
  /** ED2 — erase the entire display. */
  EntireDisplay: 2,
} as const;

/** Regex-source escapes of the same bytes, for patterns built via `new RegExp`. */
export const ControlBytePattern = {
  /** ESC (0x1b) as regex source. */
  Esc: "\\x1b",
  /** CSI prefix (ESC [) as regex source. */
  Csi: "\\x1b\\[",
} as const;
