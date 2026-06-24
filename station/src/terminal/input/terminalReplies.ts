// The outer terminal answers capability queries (OpenTUI probes XTVERSION,
// OSC 10/11 colors, cursor position, window size at startup; tmux reshapes
// the timing) and unconsumed replies fall through to the key-sequence
// handlers. A keyboard can never produce these shapes, so anything matching
// must be stripped before pane passthrough — otherwise the replies are
// "typed" into the shell as junk like `^[]10;rgb:ffff/ffff/ffff^G`.
const REPLY_PATTERNS = [
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC report ... BEL/ST
  "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS report (XTVERSION, DECRPSS) ... ST
  "\\x1b_[^\\x1b]*\\x1b\\\\", // APC report (kitty graphics `_Gi=...;OK`) ... ST
  "\\x1b\\[\\?\\d+(?:;\\d+)*\\$y", // DECRPM private-mode reports (CSI ? Pm ; Ps $ y)
  "\\x1b\\[\\?\\d+(?:;\\d+)*[Rncu]", // DEC DSR/CPR/DA1/kitty-flags replies
  "\\x1b\\[>\\d+(?:;\\d+)*c", // DA2 reply
  "\\x1b\\[\\d+(?:;\\d+)*[Rn]", // CPR / DSR replies
  "\\x1b\\[\\d+(?:;\\d+)*t", // XTWINOPS size reports
];

const REPLY_MATCHER = new RegExp(REPLY_PATTERNS.join("|"), "g");

/**
 * Removes terminal query replies from an input chunk, keeping anything else
 * (a burst can interleave real keystrokes with reports). Known collision:
 * modifier-F3 arrives as a CPR look-alike (`CSI 1;2R`) and is dropped —
 * acceptable next to shells executing report fragments.
 */
export function stripTerminalReplies(sequence: string): string {
  if (!sequence.includes("\x1b")) {
    return sequence;
  }
  return sequence.replace(REPLY_MATCHER, "");
}
