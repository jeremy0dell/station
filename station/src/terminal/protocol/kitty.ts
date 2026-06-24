// Kitty keyboard protocol (CSI-u) vocabulary. KEPT SEPARATE from the mouse
// modifier bits in `protocol/mouse.ts`: same informal name ("modifier bits"),
// DIFFERENT numeric domain (kitty Shift=1/Alt=2/Ctrl=4 vs mouse 4/8/16).
// Distinct catalogs make the two bitfields impossible to confuse at a call site.
export const KittyModifierBit = {
  Shift: 1,
  Alt: 2,
  Ctrl: 4,
} as const;

/** Code points kitty CSI-u uses for keys with direct legacy equivalents. */
export const KittyKey = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Space: 32,
} as const;

export const KittyEvent = {
  /** CSI-u event-type field for a key release (dropped, never forwarded). */
  Release: 3,
} as const;
