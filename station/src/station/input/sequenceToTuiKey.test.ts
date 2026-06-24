import { describe, expect, it } from "bun:test";
import { sequenceToTuiKey } from "./sequenceToTuiKey.js";

describe("sequenceToTuiKey", () => {
  it("translates named sequences", () => {
    expect(sequenceToTuiKey("\r")).toEqual({ input: "\r", return: true });
    expect(sequenceToTuiKey("\n")).toEqual({ input: "\n", return: true });
    expect(sequenceToTuiKey("\x1b")).toEqual({ input: "", escape: true });
    expect(sequenceToTuiKey("\x7f")).toEqual({ input: "", backspace: true });
    expect(sequenceToTuiKey("\x1b[3~")).toEqual({ input: "", delete: true });
    expect(sequenceToTuiKey("\x1b[A")).toEqual({ input: "", upArrow: true });
    expect(sequenceToTuiKey("\x1b[B")).toEqual({ input: "", downArrow: true });
    expect(sequenceToTuiKey("\x1b[C")).toEqual({ input: "", rightArrow: true });
    expect(sequenceToTuiKey("\x1b[D")).toEqual({ input: "", leftArrow: true });
    expect(sequenceToTuiKey("\x1bOA")).toEqual({ input: "", upArrow: true });
  });

  it("translates control bytes to ctrl chords", () => {
    expect(sequenceToTuiKey("\x03")).toEqual({ input: "c", ctrl: true });
    expect(sequenceToTuiKey("\x15")).toEqual({ input: "u", ctrl: true });
    expect(sequenceToTuiKey("\x11")).toEqual({ input: "q", ctrl: true });
  });

  it("passes printables through, including unicode", () => {
    expect(sequenceToTuiKey("N")).toEqual({ input: "N" });
    expect(sequenceToTuiKey("/")).toEqual({ input: "/" });
    expect(sequenceToTuiKey("?")).toEqual({ input: "?" });
    expect(sequenceToTuiKey(" ")).toEqual({ input: " " });
    expect(sequenceToTuiKey("é")).toEqual({ input: "é" });
  });

  it("refuses unknown escape sequences so they cannot leak into text inputs", () => {
    expect(sequenceToTuiKey("\x1b[15~")).toBeUndefined();
    expect(sequenceToTuiKey("\x1b[1;5C")).toBeUndefined();
    expect(sequenceToTuiKey("\x1c")).toBeUndefined();
  });

  it("keeps bare escape distinct from CSI-prefixed keys", () => {
    expect(sequenceToTuiKey("\x1b")?.escape).toBe(true);
    expect(sequenceToTuiKey("\x1b[A")?.escape).toBeUndefined();
  });
});
