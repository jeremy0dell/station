import { describe, expect, it } from "bun:test";
import {
  CsiCommand,
  EscCommand,
  isPrimaryCsiParameter,
} from "./identifiers.js";

describe("VT command identifiers", () => {
  it("pins complete DEC and reset identities", () => {
    expect(CsiCommand.SetDecPrivateMode).toEqual({ prefix: "?", final: "h" });
    expect(CsiCommand.ResetDecPrivateMode).toEqual({ prefix: "?", final: "l" });
    expect(CsiCommand.SoftReset).toEqual({ intermediates: "!", final: "p" });
    expect(EscCommand.ResetToInitialState).toEqual({ final: "c" });
  });

  it("pins complete erase, save-cursor, and Kitty identities", () => {
    expect(CsiCommand.EraseInDisplay).toEqual({ final: "J" });
    expect(CsiCommand.SaveCursor).toEqual({ final: "s" });
    expect(EscCommand.SaveCursor).toEqual({ final: "7" });
    expect(CsiCommand.KittyPushFlags).toEqual({ prefix: ">", final: "u" });
    expect(CsiCommand.KittyUpdateFlags).toEqual({ prefix: "=", final: "u" });
    expect(CsiCommand.KittyPopFlags).toEqual({ prefix: "<", final: "u" });
    expect(CsiCommand.KittyQueryFlags).toEqual({ prefix: "?", final: "u" });
  });

  it("shares xterm primary-parameter narrowing across parser consumers", () => {
    expect([1, [2, 3], 4].filter(isPrimaryCsiParameter)).toEqual([1, 4]);
  });
});
