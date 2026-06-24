import type { KittyKeyboardOptions } from "@opentui/core";

// Default kitty keyboard flags still encode Shift+Enter as legacy CR. Station
// needs all keys as escapes so the outer terminal preserves the Shift modifier
// before the pane-specific de-escalation logic decides what the child receives.
export const STATION_KEYBOARD_PROTOCOL = {
  allKeysAsEscapes: true,
} satisfies KittyKeyboardOptions;
