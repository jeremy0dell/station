import { describe, expect, it } from "bun:test";
import { EscSequence } from "./esc.js";

describe("ESC sequence vocabulary", () => {
  it("pins RIS and DECSC bytes", () => {
    expect(EscSequence.ResetToInitialState).toBe("\x1bc");
    expect(EscSequence.SaveCursor).toBe("\x1b7");
  });
});
