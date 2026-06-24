// The mouse half of Station's terminal protocol vocabulary: the two axes that
// historically collided on the string "x10", the SGR/legacy bit constants, and
// the single pair of report builders shared by the click/hover and wheel paths.
//
// NOTE: a separate, unrelated `input/mouse.ts` models Station's own UI mouse
// events — import the protocol vocabulary from here (`protocol/mouse.js`), not
// from there.
import { ControlByte } from "./controlBytes.js";

/**
 * Which pointer events the child app asked for. Values come VERBATIM from
 * xterm's `terminal.modes.mouseTrackingMode`, so they are fixed wire labels —
 * the named members only attach meaning, they cannot change the strings.
 * DECSET map: 9 -> x10, 1000 -> vt200, 1002 -> drag, 1003 -> any.
 */
export const MouseTracking = {
  /** DECSET 9: press-only, no release, no modifiers. */
  X10: "x10",
  /** DECSET 1000: button press + release. */
  Vt200: "vt200",
  /** DECSET 1002: button-event (motion while a button is held). */
  Drag: "drag",
  /** DECSET 1003: any-event motion, button or not (hover). */
  Any: "any",
} as const;
export type MouseTrackingValue = (typeof MouseTracking)[keyof typeof MouseTracking];

/**
 * How a report is serialized on the wire. Named off the "x10" symbol to break
 * the collision with {@link MouseTracking.X10}; the runtime VALUE of `Legacy`
 * stays "x10" because it is the existing wire contract and tests assert it.
 */
export const MouseEncoding = {
  /** DECSET 1006 on: SGR form (\x1b[<...M/m), no 223-cell cap. */
  Sgr: "sgr",
  /** DECSET 1006 off: the original \x1b[M + 32-offset byte form. */
  Legacy: "x10",
} as const;
export type MouseEncodingValue = (typeof MouseEncoding)[keyof typeof MouseEncoding];

/** The pointer-button names a report can carry (single source of truth). */
export type MouseButtonName = "left" | "middle" | "right" | "none";

/** Base SGR/legacy button codes. */
export const MouseButton = {
  Left: 0,
  Middle: 1,
  Right: 2,
  None: 3,
} as const;

export const MOUSE_BUTTON_BY_NAME: Record<MouseButtonName, number> = {
  left: MouseButton.Left,
  middle: MouseButton.Middle,
  right: MouseButton.Right,
  none: MouseButton.None,
};

/** Wheel scroll button codes (SGR). */
export const MouseWheelButton = {
  Up: 64,
  Down: 65,
} as const;

/** Buttonless motion marker folded into the button byte. */
export const MouseMotionBit = 32;

/**
 * Modifier bits folded into the button byte. MOUSE domain only — deliberately
 * NOT the same field as kitty's modifier bits (see `protocol/kitty.ts`), which
 * share the informal name but use a different numeric domain.
 */
export const MouseModifierBit = {
  Shift: 4,
  Alt: 8,
  Ctrl: 16,
} as const;

/**
 * Legacy byte encoding offsets every byte by 32 and a byte tops out at 255, so
 * cells past 223 can't be represented; we clamp rather than corrupt the stream.
 */
export const MouseLegacy = {
  Offset: 32,
  MaxCell: 223,
} as const;

const SGR_MOUSE_PREFIX = `${ControlByte.Csi}<`;
const LEGACY_MOUSE_PREFIX = `${ControlByte.Csi}M`;

/**
 * Fold the action/motion marker and modifiers onto a base button code. Shared
 * by click, hover, and wheel reports so the bit math lives in exactly one place.
 */
export function encodeMouseButtonByte(opts: {
  base: number;
  motion?: boolean;
  modifiers?: { shift: boolean; alt: boolean; ctrl: boolean };
}): number {
  let cb = opts.base;
  if (opts.motion === true) {
    cb += MouseMotionBit;
  }
  const m = opts.modifiers;
  if (m?.shift === true) {
    cb += MouseModifierBit.Shift;
  }
  if (m?.alt === true) {
    cb += MouseModifierBit.Alt;
  }
  if (m?.ctrl === true) {
    cb += MouseModifierBit.Ctrl;
  }
  return cb;
}

/** SGR report: \x1b[<cb;col;rowM (press/motion) or ...m (release). */
export function sgrMouseReport(cb: number, col: number, row: number, release: boolean): string {
  return `${SGR_MOUSE_PREFIX}${cb};${col};${row}${release ? "m" : "M"}`;
}

/** Legacy report: \x1b[M with every byte +32 and cells clamped to 223. */
export function legacyMouseReport(cb: number, col: number, row: number): string {
  const c = Math.min(col, MouseLegacy.MaxCell);
  const r = Math.min(row, MouseLegacy.MaxCell);
  const byte = (code: number): string => String.fromCharCode(code + MouseLegacy.Offset);
  return `${LEGACY_MOUSE_PREFIX}${byte(cb)}${byte(c)}${byte(r)}`;
}
