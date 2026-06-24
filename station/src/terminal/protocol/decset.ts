// DECSET/DECRST private-mode numbers Station parses DIRECTLY. Most mouse modes
// (9/1000/1002/1003) are parsed by xterm and surfaced via mouseTrackingMode, so
// they never appear as raw numbers here; this catalog holds only the modes
// xterm's headless build does not expose and Station tracks itself.
export const DecMode = {
  /** DECTCEM cursor visibility (?25h/?25l). */
  CursorVisible: 25,
  /** SGR mouse encoding (?1006h/?1006l). */
  SgrMouse: 1006,
} as const;
