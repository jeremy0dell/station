import { C0, VtPrefix, VtTerminator } from "../protocol/syntax.js";

// The outer terminal answers capability queries (OpenTUI probes XTVERSION,
// OSC 10/11 colors, cursor position, window size at startup; tmux reshapes
// the timing) and unconsumed replies fall through to the key-sequence
// handlers. A keyboard can never produce these shapes, so anything matching
// must be stripped before pane passthrough — otherwise the replies are
// "typed" into the shell as junk like `^[]10;rgb:ffff/ffff/ffff^G`.
const esc = regexSource(C0.Escape);
const bell = regexSource(C0.Bell);
const csi = regexSource(VtPrefix.Csi);
const stringTerminator = regexSource(VtTerminator.String);

const REPLY_PATTERNS = [
  `${regexSource(VtPrefix.Osc)}[^${bell}${esc}]*(?:${bell}|${stringTerminator})`, // OSC report ... BEL/ST
  `${regexSource(VtPrefix.Dcs)}[^${esc}]*${stringTerminator}`, // DCS report ... ST
  `${regexSource(VtPrefix.Apc)}[^${esc}]*${stringTerminator}`, // APC report ... ST
  `${csi}\\?\\d+(?:;\\d+)*\\$y`, // DECRPM private-mode reports
  `${csi}\\?\\d+(?:;\\d+)*[Rncu]`, // DEC DSR/CPR/DA1/kitty-flags replies
  `${csi}>\\d+(?:;\\d+)*c`, // DA2 reply
  `${csi}\\d+(?:;\\d+)*[Rn]`, // CPR / DSR replies
  `${csi}\\d+(?:;\\d+)*t`, // XTWINOPS size reports
];

const REPLY_MATCHER = new RegExp(REPLY_PATTERNS.join("|"), "g");

/**
 * Removes terminal query replies from an input chunk, keeping anything else
 * (a burst can interleave real keystrokes with reports). Known collision:
 * modifier-F3 arrives as a CPR look-alike (`CSI 1;2R`) and is dropped —
 * acceptable next to shells executing report fragments.
 */
export function stripTerminalReplies(sequence: string): string {
  if (!sequence.includes(C0.Escape)) {
    return sequence;
  }
  return sequence.replace(REPLY_MATCHER, "");
}

function regexSource(value: string): string {
  let source = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      source += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return source;
}
