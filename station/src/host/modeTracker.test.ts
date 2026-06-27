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

  it("prefers the highest-priority alt-screen variant in use", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?47h\x1b[?1049h");
    expect(tracker.restoreSequence()).toBe("\x1b[?1049h");
  });
});
