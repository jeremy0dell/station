/** OSC commands emitted or observed directly by Station. */
export const OscCommand = {
  WindowTitle: 2,
  DefaultForeground: 10,
  DefaultBackground: 11,
  Clipboard: 52,
} as const;
/** OSC command values composed by Station. */
export type OscCommandValue = (typeof OscCommand)[keyof typeof OscCommand];
