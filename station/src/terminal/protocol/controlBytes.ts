// Named control-byte / prefix constants so raw \x1b and \x1b[ stop appearing
// inline as bare bytes. The regex-source escapes in `terminalReplies.ts`
// ("\\x1b" etc.) are a different representation and intentionally do not consume
// this catalog.
export const ControlByte = {
  /** ESC (0x1b). */
  Esc: "\x1b",
  /** CSI prefix (ESC [). */
  Csi: "\x1b[",
} as const;
