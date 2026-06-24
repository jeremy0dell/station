import { describe, expect, it } from "bun:test";
import { buildKittyKeyboardFlags } from "@opentui/core";
import { STATION_KEYBOARD_PROTOCOL } from "./keyboardProtocol.js";

const KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES = 0b1000;

describe("STATION_KEYBOARD_PROTOCOL", () => {
  it("requests all keys as escapes so outer Shift+Enter is distinguishable", () => {
    const flags = buildKittyKeyboardFlags(STATION_KEYBOARD_PROTOCOL);

    expect(STATION_KEYBOARD_PROTOCOL.allKeysAsEscapes).toBe(true);
    expect(flags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES).toBe(
      KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES,
    );
  });
});
