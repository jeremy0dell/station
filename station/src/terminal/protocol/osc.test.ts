import { describe, expect, it } from "bun:test";
import { OscCommand } from "./osc.js";
import { VtPrefix, VtTerminator } from "./syntax.js";

describe("OSC protocol vocabulary", () => {
  it("composes BEL-terminated color replies", () => {
    expect(
      `${VtPrefix.Osc}${OscCommand.DefaultForeground};rgb:0101/0202/0303${VtTerminator.Bell}`,
    ).toBe("\x1b]10;rgb:0101/0202/0303\x07");
  });

  it("composes ST-terminated title payloads without rewriting bytes", () => {
    expect(
      `${VtPrefix.Osc}${OscCommand.WindowTitle};a;b${VtTerminator.String}`,
    ).toBe("\x1b]2;a;b\x1b\\");
  });
});
