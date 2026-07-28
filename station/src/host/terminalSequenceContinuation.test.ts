import { describe, expect, it } from "bun:test";
import { TerminalSequenceContinuation } from "./terminalSequenceContinuation.js";

describe("TerminalSequenceContinuation", () => {
  it("mirrors every persistent VT500 parser state", () => {
    for (const [input, expected] of [
      ["plain", ""],
      ["\x1b", "\x1b"],
      ["\x1b(", "\x1b("],
      ["\x1b[", "\x1b["],
      ["\x1b[31", "\x1b[31"],
      ["\x1b[31 ", "\x1b[31 "],
      ["\x1b[31?", "\x1b[31?"],
      ["\x1b]2;title", "\x1b]2;title"],
      ["\x1bP", "\x1bP"],
      ["\x1bP1", "\x1bP1"],
      ["\x1bP1$", "\x1bP1$"],
      ["\x1bP1?ignored", "\x1bP1?"],
      ["\x1bP$qpayload", "\x1bP$qpayload"],
      ["\x1b_ignored", "\x1b_"],
    ] as const) {
      const continuation = new TerminalSequenceContinuation();
      continuation.feed(input);
      expect(continuation.captureSequence()).toBe(expected);
    }
  });

  it("retains unfinished CSI state without replaying executed controls", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("prefix\x1b[31\b");
    expect(continuation.captureSequence()).toBe("\x1b[31");

    continuation.feed("mX");
    expect(continuation.captureSequence()).toBe("");
  });

  it("retains OSC through chunks and recognizes BEL and ST termination", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b]2;new-title");
    expect(continuation.captureSequence()).toBe("\x1b]2;new-title");
    continuation.feed("\x07");
    expect(continuation.captureSequence()).toBe("");

    continuation.feed("\x1b]2;next\x1b");
    expect(continuation.captureSequence()).toBe("\x1b");
    continuation.feed("\\");
    expect(continuation.captureSequence()).toBe("");
  });

  it("retains DCS payload controls while dropping ignored header controls", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b\bP$qm\b");
    expect(continuation.captureSequence()).toBe("\x1bP$qm\b");
    continuation.feed("\x1b\\");
    expect(continuation.captureSequence()).toBe("");
  });

  it("mirrors xterm's write-scoped DCS DEL read-ahead", () => {
    const sameWrite = new TerminalSequenceContinuation();
    sameWrite.feed("\x1bP$qm\x7f");
    expect(sameWrite.captureSequence()).toBe("\x1bP$qm\x7f");

    const splitWrite = new TerminalSequenceContinuation();
    splitWrite.feed("\x1bP$qm");
    splitWrite.feed("\x7f");
    expect(splitWrite.captureSequence()).toBe("\x1bP$qm");
  });

  it("keeps ignored parser states without retaining irrelevant payload", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b[1?;2");
    expect(continuation.captureSequence()).toBe("\x1b[1?");
    continuation.feed("m");
    expect(continuation.captureSequence()).toBe("");

    continuation.feed("\x1b_X".repeat(100));
    expect(continuation.captureSequence()).toBe("\x1b_");
    continuation.feed("\x1b\\");
    expect(continuation.captureSequence()).toBe("");
  });

  it("returns SOS, PM, and APC strings to ground on non-ASCII input", () => {
    for (const introducer of ["\x1bX", "\x1b^", "\x1b_"]) {
      const continuation = new TerminalSequenceContinuation();
      continuation.feed(`${introducer}ignoredé`);
      expect(continuation.captureSequence()).toBe("");
    }
  });

  it("fails closed at the cap and recovers only after termination or restart", () => {
    const continuation = new TerminalSequenceContinuation(12);

    continuation.feed("\x1b]2;12345678");
    expect(continuation.captureSequence()).toBe("\x1b]2;12345678");
    continuation.feed("9");
    expect(() => continuation.captureSequence()).toThrow(/12-code-unit capture limit/u);
    continuation.feed("\x07");

    continuation.feed("\x1b]2;123456789");
    expect(() => continuation.captureSequence()).toThrow(/12-code-unit capture limit/u);
    continuation.feed("still-overflowed");
    expect(() => continuation.captureSequence()).toThrow(/12-code-unit capture limit/u);
    continuation.feed("\x07\x1b[31");
    expect(continuation.captureSequence()).toBe("\x1b[31");

    continuation.feed("\x1b]2;123456789\x1b[");
    expect(continuation.captureSequence()).toBe("\x1b[");
  });

  it("supports C1 control sequence introducers", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\u009b31");
    expect(continuation.captureSequence()).toBe("\u009b31");
    continuation.feed("m");
    expect(continuation.captureSequence()).toBe("");
  });

  it("preserves xterm's pending UTF-16 decoder state", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b]2;emoji-\ud83d");
    expect(continuation.captureSequence()).toBe("\x1b]2;emoji-\ud83d");
    continuation.feed("\ude42");
    expect(continuation.captureSequence()).toBe("\x1b]2;emoji-🙂");
  });

  it("drops ordinary BOMs like xterm's UTF-16 decoder", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b]2;left\ufeffright");

    expect(continuation.captureSequence()).toBe("\x1b]2;leftright");
  });

  it("preserves xterm's UCS-2 fallback for a pending high surrogate followed by BOM", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b]2;\ud83d");
    continuation.feed("\ufeff");

    expect(continuation.captureSequence()).toBe("\x1b]2;\ud83d\ufeff");
  });

  it("flushes an emitted lone high surrogate without making it pending on replay", () => {
    const continuation = new TerminalSequenceContinuation();

    continuation.feed("\x1b]2;x\ud83d\0");

    expect(continuation.captureSequence()).toBe("\x1b]2;x\ud83d\0");
  });
});
