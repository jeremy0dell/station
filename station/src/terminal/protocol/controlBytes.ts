// Named control-byte / prefix constants so raw \x1b and \x1b[ stop appearing
// inline as bare bytes. ControlBytePattern carries the regex-source escapes of
// the same prefixes; character-class uses (as in `terminalReplies.ts`) still
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
  /** EL — Erase in Line (CSI Ps K). */
  EraseInLine: "K",
  /** ECH — Erase Character (CSI Ps X). */
  EraseCharacter: "X",
} as const;

export const EscIdentifier = {
  /** RIS — Reset to Initial State (ESC c). */
  ResetToInitialState: { final: "c" },
} as const;

export const CsiIdentifier = {
  /** DECSTR — Soft Terminal Reset (CSI ! p). */
  SoftTerminalReset: { intermediates: "!", final: "p" },
} as const;

export const EraseInDisplayMode = {
  /** ED0 — erase from the cursor through the end of the viewport. */
  CursorToEnd: 0,
  /** ED1 — erase from the start of the viewport through the cursor. */
  StartToCursor: 1,
  /** ED2 — erase the entire viewport. */
  EntireDisplay: 2,
  /** ED3 — erase saved lines. */
  SavedLines: 3,
} as const;

/** Regex-source escapes of the same bytes, for patterns built via `new RegExp`. */
export const ControlBytePattern = {
  /** ESC (0x1b) as regex source. */
  Esc: "\\x1b",
  /** CSI prefix (ESC [) as regex source. */
  Csi: "\\x1b\\[",
} as const;
