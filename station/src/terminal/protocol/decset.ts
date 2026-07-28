/** ANSI SM/RM mode numbers emitted directly by Station. */
export const AnsiMode = {
  /** IRM — insert/replace mode (4h/4l). */
  Insert: 4,
  /** LNM — line feed/new line mode (20h/20l). */
  LineFeedNewLine: 20,
} as const;

/** DECSET/DECRST private-mode numbers emitted or parsed directly by Station. */
export const DecMode = {
  /** DECOM — origin mode (?6h/?6l). */
  Origin: 6,
  /** DECAWM — auto-wrap mode (?7h/?7l). */
  Wraparound: 7,
  /** ATT610 cursor blink mode (?12h/?12l). */
  CursorBlink: 12,
  /** DECTCEM cursor visibility (?25h/?25l). */
  CursorVisible: 25,
  /** Legacy alternate screen buffer (?47h/?47l). */
  Alternate: 47,
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
  /** Synchronized output (?2026h/?2026l). */
  SynchronizedOutput: 2026,
} as const;
