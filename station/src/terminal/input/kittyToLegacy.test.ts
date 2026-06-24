import { describe, expect, it } from "bun:test";
import { kittySequenceToLegacy } from "./kittyToLegacy.js";

describe("kittySequenceToLegacy", () => {
  it("translates ctrl chords to control bytes", () => {
    expect(kittySequenceToLegacy("\x1b[99;5u")).toBe("\x03"); // Ctrl-C
    expect(kittySequenceToLegacy("\x1b[100;5u")).toBe("\x04"); // Ctrl-D
    expect(kittySequenceToLegacy("\x1b[122;5u")).toBe("\x1a"); // Ctrl-Z
  });

  it("translates the escape key", () => {
    expect(kittySequenceToLegacy("\x1b[27u")).toBe("\x1b");
  });

  it("translates enter, tab, backspace, and space variants", () => {
    expect(kittySequenceToLegacy("\x1b[13u")).toBe("\r");
    expect(kittySequenceToLegacy("\x1b[13;2u")).toBe("\r"); // Shift-Enter -> CR for legacy shells
    expect(kittySequenceToLegacy("\x1b[13;2u", { preserveModifiedEnter: true })).toBe("\x1b[13;2u"); // agent pane keeps raw CSI-u
    expect(kittySequenceToLegacy("\x1b[27;2;13~")).toBe("\r"); // xterm Shift-Enter
    expect(kittySequenceToLegacy("\x1b[27;2;13~", { preserveModifiedEnter: true })).toBe(
      "\x1b[13;2u",
    );
    expect(kittySequenceToLegacy("\x1b[9u")).toBe("\t");
    expect(kittySequenceToLegacy("\x1b[9;2u")).toBe("\x1b[Z"); // Shift-Tab
    expect(kittySequenceToLegacy("\x1b[127u")).toBe("\x7f");
    expect(kittySequenceToLegacy("\x1b[32;5u")).toBe("\x00"); // Ctrl-Space
  });

  it("prefixes escape for alt chords", () => {
    expect(kittySequenceToLegacy("\x1b[98;3u")).toBe("\x1bb"); // Alt-b
    expect(kittySequenceToLegacy("\x1b[99;7u")).toBe("\x1b\x03"); // Ctrl-Alt-C
  });

  it("prefers the shifted alternate for shift chords", () => {
    expect(kittySequenceToLegacy("\x1b[49:33;2u")).toBe("!"); // Shift-1
    expect(kittySequenceToLegacy("\x1b[27;2;49~")).toBe("!"); // xterm Shift-1 fallback
  });

  it("drops key release events", () => {
    expect(kittySequenceToLegacy("\x1b[99;5:3u")).toBe("");
  });

  it("passes non-csi-u sequences through unchanged", () => {
    expect(kittySequenceToLegacy("a")).toBe("a");
    expect(kittySequenceToLegacy("\x1b[A")).toBe("\x1b[A");
    expect(kittySequenceToLegacy("\x1b[1;5A")).toBe("\x1b[1;5A");
    expect(kittySequenceToLegacy("\x03")).toBe("\x03");
  });

  it("drops unknown functional keys instead of leaking csi-u bytes", () => {
    expect(kittySequenceToLegacy("\x1b[57441;1u")).toBe(""); // left shift press
  });

  it("translates keypad keys to their legacy equivalents", () => {
    expect(kittySequenceToLegacy("\x1b[57414u")).toBe("\r"); // keypad Enter
    expect(kittySequenceToLegacy("\x1b[57400u")).toBe("1");
    expect(kittySequenceToLegacy("\x1b[57413u")).toBe("+");
    expect(kittySequenceToLegacy("\x1b[57419u")).toBe("\x1b[A"); // keypad up
    expect(kittySequenceToLegacy("\x1b[57420u")).toBe("\x1b[B"); // keypad down
    expect(kittySequenceToLegacy("\x1b[57418u")).toBe("\x1b[C"); // keypad right
    expect(kittySequenceToLegacy("\x1b[57417u")).toBe("\x1b[D"); // keypad left
  });

  it("maps ctrl punctuation and digit chords to xterm control bytes", () => {
    expect(kittySequenceToLegacy("\x1b[27;5;111~")).toBe("\x0f"); // xterm Ctrl-O
    expect(kittySequenceToLegacy("\x1b[47;5u")).toBe("\x1f"); // Ctrl-/
    expect(kittySequenceToLegacy("\x1b[63;5u")).toBe("\x7f"); // Ctrl-?
    expect(kittySequenceToLegacy("\x1b[50;5u")).toBe("\x00"); // Ctrl-2
    expect(kittySequenceToLegacy("\x1b[54;5u")).toBe("\x1e"); // Ctrl-6
  });

  it("drops out-of-range code points instead of throwing", () => {
    expect(kittySequenceToLegacy("\x1b[1114112u")).toBe(""); // 0x110000
    expect(kittySequenceToLegacy("\x1b[99999999u")).toBe("");
  });

  it("drops untranslatable xterm modified keys instead of leaking bytes", () => {
    expect(kittySequenceToLegacy("\x1b[27;1;57441~")).toBe(""); // left shift press
  });
});
