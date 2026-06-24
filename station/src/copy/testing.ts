import type { ClipboardEffects } from "./clipboard.js";

/**
 * Clipboard effects that write nowhere — for tests and mock mode, where copy
 * must not touch the host or spawn a process. Production injects real effects.
 */
export const NO_OP_CLIPBOARD_EFFECTS: ClipboardEffects = {
  setInternal: () => {},
  writeOsc52: () => {},
  copyToPlatform: () => {},
  isRemoteSession: () => false,
};
