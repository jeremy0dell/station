import type { TuiBindingSpec } from "../keymap.js";

/**
 * The ↑↓/↵/slot binding block a registered list contributes to its keymap table.
 * Generic over the action prefix so action strings stay LITERAL — a helper that
 * widened them to `string` (as editableTextBindings does) would break the
 * dashboard's assertNever exhaustive switch if ever spread into that table.
 */
export function selectableListBindings<P extends string>(prefix: P) {
  return [
    {
      id: `${prefix}.cursorUp`,
      pattern: { kind: "named", named: "up" },
      action: `${prefix}.cursorUp`,
      outcome: "handled",
    },
    {
      id: `${prefix}.cursorDown`,
      pattern: { kind: "named", named: "down" },
      action: `${prefix}.cursorDown`,
      outcome: "handled",
      help: { keys: "↑↓", label: "move cursor" },
    },
    {
      id: `${prefix}.activate`,
      pattern: { kind: "named", named: "return" },
      action: `${prefix}.activate`,
      outcome: "handled",
      help: { keys: "↵", label: "choose" },
    },
    {
      id: `${prefix}.slot`,
      pattern: { kind: "slot" },
      action: `${prefix}.slot`,
      outcome: "handled",
      help: { keys: "1-9 a-z", label: "jump to item" },
    },
  ] as const satisfies readonly TuiBindingSpec[];
}
