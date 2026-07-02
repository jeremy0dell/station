// Translates the router's normalized legacy byte sequences into the shared
// machine's TuiKey vocabulary (apps/tui receives these pre-parsed from Ink;
// Station receives raw legacy bytes after reply-stripping and kitty
// translation). Full-sequence exact matching keeps bare Esc ("\x1b") and
// CSI-prefixed keys ("\x1b[A") distinct. Returns undefined for sequences the
// dashboard has no vocabulary for (F-keys, unknown CSI) — the overlay layer
// swallows those without dispatching, so stray escape sequences can never
// leak into text-input modes as garbage characters.
import type { TuiKey } from "@station/dashboard-core";
import { ARROW_KEYS } from "../../terminal/protocol/cursorKeys.js";

const NAMED_SEQUENCES: Record<string, TuiKey> = {
  "\r": { input: "\r", return: true },
  "\n": { input: "\n", return: true },
  "\x1b": { input: "", escape: true },
  "\x7f": { input: "", backspace: true },
  "\b": { input: "", backspace: true },
  "\x1b[3~": { input: "", delete: true },
  [ARROW_KEYS.up.normal]: { input: "", upArrow: true },
  [ARROW_KEYS.down.normal]: { input: "", downArrow: true },
  [ARROW_KEYS.right.normal]: { input: "", rightArrow: true },
  [ARROW_KEYS.left.normal]: { input: "", leftArrow: true },
  // Application cursor mode (DECCKM) variants.
  [ARROW_KEYS.up.application]: { input: "", upArrow: true },
  [ARROW_KEYS.down.application]: { input: "", downArrow: true },
  [ARROW_KEYS.right.application]: { input: "", rightArrow: true },
  [ARROW_KEYS.left.application]: { input: "", leftArrow: true },
};

export function sequenceToTuiKey(sequence: string): TuiKey | undefined {
  const named = NAMED_SEQUENCES[sequence];
  if (named !== undefined) {
    return { ...named };
  }

  if (sequence.length === 1) {
    const code = sequence.charCodeAt(0);
    // Control bytes map to ctrl+letter (Ctrl-C = \x03 -> {input:"c", ctrl}).
    // \r/\n and \x1b are named above. Legacy encoding cannot distinguish Tab
    // from Ctrl-I: \t reaches the dashboard as {input:"i", ctrl}, which the
    // keymap's next-needs-me binding deliberately matches.
    if (code >= 0x01 && code <= 0x1a) {
      return { input: String.fromCharCode(code + 0x60), ctrl: true };
    }
    if (code < 0x20) {
      return undefined;
    }
  }

  if (containsControlBytes(sequence)) {
    return undefined;
  }

  return { input: sequence };
}

function containsControlBytes(sequence: string): boolean {
  for (const char of sequence) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Paste bypasses key translation, so sanitize it separately: single-line inputs
 * get spaces for newlines and no other control bytes.
 */
export function sanitizePastedText(text: string): string {
  let sanitized = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d) {
      sanitized += " ";
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    sanitized += char;
  }
  return sanitized;
}
