/** ANSI SM/RM mode numbers emitted directly by Station. */
export const AnsiMode = {
  /** IRM — insert/replace mode (4h/4l). */
  Insert: 4,
  /** LNM — line feed/new line mode (20h/20l). */
  LineFeedNewLine: 20,
} as const;

/** DECSET/DECRST private-mode numbers emitted or parsed directly by Station. */
export const DecMode = {
  /** DECCKM — application cursor keys (?1h/?1l). */
  ApplicationCursorKeys: 1,
  /** DECOM — origin mode (?6h/?6l). */
  Origin: 6,
  /** DECAWM — auto-wrap mode (?7h/?7l). */
  Wraparound: 7,
  /** X10 mouse tracking (?9h/?9l). */
  MouseX10: 9,
  /** ATT610 cursor blink mode (?12h/?12l). */
  CursorBlink: 12,
  /** DECTCEM cursor visibility (?25h/?25l). */
  CursorVisible: 25,
  /** Reverse wraparound mode (?45h/?45l). */
  ReverseWraparound: 45,
  /** Legacy alternate screen buffer (?47h/?47l). */
  Alternate: 47,
  /** DECNKM — application keypad mode (?66h/?66l). */
  ApplicationKeypad: 66,
  /** VT200 mouse tracking (?1000h/?1000l). */
  MouseVt200: 1000,
  /** Button-event mouse tracking (?1002h/?1002l). */
  MouseButtonEvent: 1002,
  /** Any-event mouse tracking (?1003h/?1003l). */
  MouseAnyEvent: 1003,
  /** Focus event reporting (?1004h/?1004l). */
  FocusReporting: 1004,
  /** SGR mouse encoding (?1006h/?1006l). */
  SgrMouse: 1006,
  /** SGR pixel mouse encoding (?1016h/?1016l). */
  SgrPixels: 1016,
  /** Alternate screen buffer with clear-on-enter (?1047h/?1047l). */
  AlternateClear: 1047,
  /** Save or restore cursor state (?1048h/?1048l). */
  SaveCursor: 1048,
  /** Save cursor and switch alternate screen (?1049h/?1049l). */
  SaveCursorAndAlternate: 1049,
  /** Bracketed paste mode (?2004h/?2004l). */
  BracketedPaste: 2004,
  /** Synchronized output (?2026h/?2026l). */
  SynchronizedOutput: 2026,
} as const;

/** DEC private-mode values Station emits or interprets directly. */
export type DecModeValue = (typeof DecMode)[keyof typeof DecMode];
