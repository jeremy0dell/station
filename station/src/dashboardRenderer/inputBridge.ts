import type { TuiStore } from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
// Import the specific modules, not ../terminal/index.js — that barrel also
// re-exports node-pty-backed PTY/VT/pane machinery the dashboard never uses,
// which would pull node-pty into this multiplexer-free renderer.
import { kittySequenceToLegacy } from "../terminal/input/kittyToLegacy.js";
import { stripTerminalReplies } from "../terminal/input/terminalReplies.js";
import { sequenceToTuiKey } from "../station/input/sequenceToTuiKey.js";

/**
 * A `prependInputHandlers` entry: normalize raw terminal bytes the same way the
 * Station input runtime does (strip query replies, fold kitty CSU back to
 * legacy), translate to the shared `TuiKey` vocabulary, and dispatch into the
 * dashboard store. Always returns true — unknown/functional sequences are
 * swallowed so stray escapes never leak into text-input modes as garbage.
 */
export function createDashboardSequenceHandler(
  store: StoreApi<TuiStore>,
): (sequence: string) => boolean {
  return (sequence: string) => {
    const stripped = stripTerminalReplies(sequence);
    if (stripped === "" && sequence !== "") {
      return true; // terminal query reply (e.g. cursor position report)
    }
    const legacy = kittySequenceToLegacy(stripped);
    if (legacy === "") {
      return true; // key release / untranslatable functional key
    }
    const key = sequenceToTuiKey(legacy);
    if (key === undefined) {
      return true; // a sequence the dashboard has no vocabulary for
    }
    store.getState().handleKey(key);
    return true;
  };
}
