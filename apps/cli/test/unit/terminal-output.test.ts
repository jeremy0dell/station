import { describe, expect, it } from "vitest";
import { escapeTerminalBytes, formatCliOutput } from "../../src/terminalOutput.js";

const codePoints = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => String.fromCodePoint(start + index)).join(
    "",
  );
const c0 = codePoints(0x00, 0x1f);
const jsonLiteralHazards = [
  codePoints(0x7f, 0x9f),
  "\u061c",
  "\u200e\u200f",
  codePoints(0x2028, 0x202e),
  codePoints(0x2066, 0x2069),
].join("");

describe("CLI terminal output", () => {
  it("keeps pretty JSON valid while escaping every literal terminal hazard", () => {
    const payload = { value: `before${c0}${jsonLiteralHazards}after` };
    const output = formatCliOutput({ code: 0, output: payload });

    expect(output).toContain('\n  "value":');
    expect(JSON.parse(output)).toEqual(payload);
    for (const character of jsonLiteralHazards) expect(output).not.toContain(character);
    for (const codePoint of [...Array.from({ length: 0x20 }, (_, index) => index)]) {
      if (codePoint !== 0x0a) expect(output).not.toContain(String.fromCodePoint(codePoint));
    }
    expect(output).toContain("\\u0000");
    expect(output).toContain("\\n");
  });

  it("preserves text layout while escaping hostile field content", () => {
    const field = escapeTerminalBytes(`first\nsecond${jsonLiteralHazards}`);
    const output = formatCliOutput({
      code: 0,
      outputFormat: "text",
      output: `heading: ${field}\nnext: safe\n`,
    });

    expect(output).toContain("heading: first\\u000asecond");
    expect(output).toContain("\nnext: safe\n");
    expect(output.split("\n")).toHaveLength(3);
    for (const character of jsonLiteralHazards) expect(output).not.toContain(character);
  });
});
