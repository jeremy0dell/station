import { describe, expect, it } from "bun:test";
import { LegacyKeySequence } from "./keySequences.js";

describe("legacy key-sequence vocabulary", () => {
  it("pins supported non-arrow key bytes", () => {
    expect(LegacyKeySequence.Escape).toBe("\x1b");
    expect(LegacyKeySequence.ShiftTab).toBe("\x1b[Z");
    expect(LegacyKeySequence.PageUp).toBe("\x1b[5~");
    expect(LegacyKeySequence.PageDown).toBe("\x1b[6~");
    expect(LegacyKeySequence.Home).toBe("\x1b[H");
    expect(LegacyKeySequence.End).toBe("\x1b[F");
    expect(LegacyKeySequence.Insert).toBe("\x1b[2~");
    expect(LegacyKeySequence.Delete).toBe("\x1b[3~");
  });
});
