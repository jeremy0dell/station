import { describe, expect, it } from "bun:test";
import { stripTerminalReplies } from "./terminalReplies.js";

// The exact startup burst observed inside tmux: OSC 10/11 color reports,
// an XTVERSION DCS reply ("tmux 3.6b"), cursor position reports, a
// color-scheme DSR, and an XTWINOPS pixel-size report.
const TMUX_STARTUP_BURST =
  "\x1b]10;rgb:ffff/ffff/ffff\x07" +
  "\x1b]11;rgb:2828/2c2c/3434\x07" +
  "\x1bP>|tmux 3.6b\x1b\\" +
  "\x1b[7;1R\x1b[1;1R\x1b[1;1R" +
  "\x1b[?997;1n" +
  "\x1b[4;2040;2704t";

// A second burst observed inside tmux: DECRPM private-mode reports (mode
// queries answered with `$y`) followed by a kitty graphics support reply
// delivered as an APC string. Neither shape was stripped before, so they
// "typed" into the boot shell as `?1016;2$y ... _Gi=31337;OK`.
const TMUX_MODE_AND_GRAPHICS_BURST =
  "\x1b[?1016;2$y\x1b[?2027;1$y\x1b[?2031;1$y" +
  "\x1b[?1004;2$y\x1b[?2004;2$y\x1b[?2026;2$y" +
  "\x1b_Gi=31337;OK\x1b\\";

describe("stripTerminalReplies", () => {
  it("strips the observed tmux startup reply burst completely", () => {
    expect(stripTerminalReplies(TMUX_STARTUP_BURST)).toBe("");
  });

  it("strips DECRPM mode reports and a kitty graphics APC reply", () => {
    expect(stripTerminalReplies(TMUX_MODE_AND_GRAPHICS_BURST)).toBe("");
  });

  it("keeps real keystrokes interleaved with reports", () => {
    expect(stripTerminalReplies(`a\x1b[3;7Rb`)).toBe("ab");
  });

  it("strips individual reply shapes", () => {
    expect(stripTerminalReplies("\x1b[1;1R")).toBe(""); // CPR
    expect(stripTerminalReplies("\x1b[?25;1$y".replace("$y", "n"))).toBe(""); // DEC DSR
    expect(stripTerminalReplies("\x1b[?1;2c")).toBe(""); // DA1 reply
    expect(stripTerminalReplies("\x1b[>0;276;0c")).toBe(""); // DA2 reply
    expect(stripTerminalReplies("\x1b[?0u")).toBe(""); // kitty flags reply
    expect(stripTerminalReplies("\x1b[8;24;80t")).toBe(""); // XTWINOPS
    expect(stripTerminalReplies("\x1b]11;rgb:1010/1313/1616\x1b\\")).toBe(""); // OSC w/ ST
    expect(stripTerminalReplies("\x1b[?2026;2$y")).toBe(""); // DECRPM private-mode report
    expect(stripTerminalReplies("\x1b_Gi=31337;OK\x1b\\")).toBe(""); // kitty graphics APC reply
  });

  it("passes keyboard sequences through untouched", () => {
    expect(stripTerminalReplies("a")).toBe("a");
    expect(stripTerminalReplies("\r")).toBe("\r");
    expect(stripTerminalReplies("\x03")).toBe("\x03");
    expect(stripTerminalReplies("\x1b[A")).toBe("\x1b[A"); // arrow
    expect(stripTerminalReplies("\x1b[1;5A")).toBe("\x1b[1;5A"); // ctrl-arrow
    expect(stripTerminalReplies("\x1b[99;5u")).toBe("\x1b[99;5u"); // kitty key
    expect(stripTerminalReplies("\x1b[3~")).toBe("\x1b[3~"); // delete
    expect(stripTerminalReplies("\x1bOP")).toBe("\x1bOP"); // F1 (SS3)
  });
});
