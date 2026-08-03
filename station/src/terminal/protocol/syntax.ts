/** C0 control characters used by Station's supported terminal protocol subset. */
export const C0 = {
  /** NUL (0x00). */
  Null: "\x00",
  /** BEL (0x07). */
  Bell: "\x07",
  /** BS (0x08). */
  Backspace: "\x08",
  /** HT (0x09). */
  HorizontalTab: "\x09",
  /** LF (0x0a). */
  LineFeed: "\x0a",
  /** CR (0x0d). */
  CarriageReturn: "\x0d",
  /** ESC (0x1b). */
  Escape: "\x1b",
} as const;

/** Multi-byte 7-bit VT introducers used by Station. */
export const VtPrefix = {
  /** Control Sequence Introducer (ESC [). */
  Csi: `${C0.Escape}[`,
  /** Operating System Command (ESC ]). */
  Osc: `${C0.Escape}]`,
  /** Device Control String (ESC P). */
  Dcs: `${C0.Escape}P`,
  /** Application Program Command (ESC _). */
  Apc: `${C0.Escape}_`,
  /** Single Shift 3 (ESC O). */
  Ss3: `${C0.Escape}O`,
} as const;

/** Terminators accepted or emitted for VT string commands. */
export const VtTerminator = {
  /** BEL terminator used by Station's OSC emitters. */
  Bell: C0.Bell,
  /** String Terminator (ESC backslash). */
  String: `${C0.Escape}\\`,
} as const;

/** Supported VT string-terminator values. */
export type VtTerminatorValue = (typeof VtTerminator)[keyof typeof VtTerminator];
