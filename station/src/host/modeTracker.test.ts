import { describe, expect, it } from "bun:test";
import { TerminalModeTracker } from "./modeTracker.js";

describe("TerminalModeTracker", () => {
  it("emits nothing when no sticky modes were set", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("plain output\r\n\x1b[31mred\x1b[0m");
    expect(tracker.restoreSequence()).toBe("");
  });

  it("re-asserts an alt-screen enter that was never left", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049hcontents of the alt screen");
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h");
  });

  it("cancels a mode toggled back off within the scanned data", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h...later...\x1b[?1049l");
    expect(tracker.restoreSequence()).toBe("");
  });

  it("restores mouse tracking + SGR encoding together", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1002h\x1b[?1006h");
    expect(tracker.restoreSequence()).toBe("\x1b[?1002h\x1b[?1006h");
  });

  it("handles a batched DECSET setting several modes at once", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049;1006h");
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h\x1b[?1006h");
  });

  it("re-hides the cursor (default-on mode) but emits nothing once shown again", () => {
    const hidden = new TerminalModeTracker();
    hidden.feed("\x1b[?25l");
    expect(hidden.restoreSequence()).toBe("\x1b[?25l");

    const shown = new TerminalModeTracker();
    shown.feed("\x1b[?25l\x1b[?25h");
    expect(shown.restoreSequence()).toBe("");
  });

  it("recognizes a DECSET sequence split across fed chunks", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("output\x1b[?10"); // chunk 1: ends mid alt-screen-enter
    tracker.feed("49h more output"); // chunk 2: completes it
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h");
  });

  it("does not carry a completed non-DECSET escape across chunks", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[31m"); // a complete SGR color, not a DECSET prefix
    tracker.feed("1049h"); // must NOT be glued into a phantom DECSET
    expect(tracker.restoreSequence()).toBe("");
  });

  it("recognizes a long semicolon-batched DECSET split across chunks", () => {
    // 6 batched params overflow the old 24-byte carry; all must survive the split.
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049;1000;1002;1003;10"); // boundary mid-batch (>24 bytes)
    tracker.feed("06;2004h");
    expect(tracker.restoreSequence()).toBe(
      "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h",
    );
  });

  it("re-asserts kitty keyboard mode from dropped setup chunks", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[>1u");
    expect(tracker.restoreSequence()).toBe("\x1b[>1u");
  });

  it("replays sticky terminal modes before kitty keyboard state", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h\x1b[>1u");
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h\x1b[>1u");
  });

  it("tracks kitty keyboard push, set, and pop in order", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[=1u\x1b[>4u\x1b[<u");
    expect(tracker.restoreSequence()).toBe("\x1b[=1u");

    tracker.feed("\x1b[=0u");
    expect(tracker.restoreSequence()).toBe("");
  });

  it("replays nested kitty keyboard stack so retained pops restore earlier flags", () => {
    const dropped = new TerminalModeTracker();
    dropped.feed("\x1b[>1u\x1b[>5u");

    const restored = new TerminalModeTracker();
    restored.feed(dropped.restoreSequence());
    restored.feed("\x1b[<u");

    expect(dropped.restoreSequence()).toBe("\x1b[>1u\x1b[>5u");
    expect(restored.restoreSequence()).toBe("\x1b[>1u");
  });

  it("recognizes a kitty keyboard sequence split across fed chunks", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("output\x1b[>");
    tracker.feed("1u more output");
    expect(tracker.restoreSequence()).toBe("\x1b[>1u");
  });

  it("clears all tracked modes on a RIS (full reset) in the dropped data", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h\x1b[?1000hsome output\x1bc"); // alt+mouse, then reset
    expect(tracker.restoreSequence()).toBe("");
  });

  it("keeps only modes set after the last RIS", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h\x1bc\x1b[?1000h"); // reset wipes alt; mouse set after
    expect(tracker.restoreSequence()).toBe("\x1b[?1000h");
  });

  it("prefers the highest-priority alt-screen variant in use", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?47h\x1b[?1049h");
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h");
  });
});
