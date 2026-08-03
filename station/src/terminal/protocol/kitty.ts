import { VtPrefix } from "./syntax.js";

/** Kitty keyboard modifier bits, distinct from the mouse modifier domain. */
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

/** Kitty key-event values interpreted directly by Station. */
export const KittyEvent = {
  /** CSI-u event-type field for a key release (dropped, never forwarded). */
  Release: 3,
} as const;

/** Kitty's flag update parameter semantics. */
export const KittyFlagUpdateMode = {
  /** Replace all flags with the supplied bitset. */
  Set: 1,
  /** Set supplied bits and preserve unset bits. */
  SetBits: 2,
  /** Clear supplied bits and preserve unset bits. */
  ClearBits: 3,
} as const;
export type KittyFlagUpdateModeValue =
  (typeof KittyFlagUpdateMode)[keyof typeof KittyFlagUpdateMode];

/** Bounded keyboard-mode stack; full pushes evict the oldest entry per the protocol. */
export const KittyKeyboard = {
  StackLimit: 64,
} as const;

/** One buffer's Kitty progressive-enhancement flags and saved stack. */
export type KittyKeyboardState = Readonly<{
  flags: number;
  stack: readonly number[];
}>;

/** Semantic Kitty keyboard transition decoded from one CSI command. */
export type KittyKeyboardOperation =
  | { type: "update"; flags: number; mode: KittyFlagUpdateModeValue }
  | { type: "push"; flags: number }
  | { type: "pop"; count: number }
  | { type: "reset" };

/** Create the default state for one normal or alternate buffer. */
export function initialKittyKeyboardState(): KittyKeyboardState {
  return { flags: 0, stack: [] };
}

/** Normalize omitted and unknown update modes to Kitty's replace-all default. */
export function normalizeKittyFlagUpdateMode(
  mode: number | undefined,
): KittyFlagUpdateModeValue {
  if (mode === KittyFlagUpdateMode.SetBits) {
    return KittyFlagUpdateMode.SetBits;
  }
  if (mode === KittyFlagUpdateMode.ClearBits) {
    return KittyFlagUpdateMode.ClearBits;
  }
  return KittyFlagUpdateMode.Set;
}

/** Apply one Kitty operation without mutating the prior state. */
export function reduceKittyKeyboardState(
  state: KittyKeyboardState,
  operation: KittyKeyboardOperation,
): KittyKeyboardState {
  switch (operation.type) {
    case "reset":
      return initialKittyKeyboardState();
    case "update":
      if (operation.mode === KittyFlagUpdateMode.SetBits) {
        return { flags: state.flags | operation.flags, stack: state.stack };
      }
      if (operation.mode === KittyFlagUpdateMode.ClearBits) {
        return { flags: state.flags & ~operation.flags, stack: state.stack };
      }
      return { flags: operation.flags, stack: state.stack };
    case "push": {
      const stack =
        state.stack.length === KittyKeyboard.StackLimit
          ? state.stack.slice(1)
          : [...state.stack];
      return { flags: operation.flags, stack: [...stack, state.flags] };
    }
    case "pop": {
      const count = Math.max(1, operation.count);
      const index = state.stack.length - count;
      return {
        flags: state.stack[index] ?? 0,
        stack: state.stack.slice(0, Math.max(0, index)),
      };
    }
  }
}

/** Complete Kitty keyboard sequences with no runtime parameters. */
export const KittySequence = {
  QueryFlags: `${VtPrefix.Csi}?u`,
} as const;

/** Recreate one buffer's stack from the default zero-flags state. */
export function serializeKittyKeyboardState(state: KittyKeyboardState): string {
  const entries = [...state.stack, state.flags];
  const initialFlags = entries[0] ?? 0;
  const parts = initialFlags === 0 ? [] : [`${VtPrefix.Csi}=${initialFlags}u`];
  for (const flags of entries.slice(1)) {
    parts.push(`${VtPrefix.Csi}>${flags}u`);
  }
  return parts.join("");
}
