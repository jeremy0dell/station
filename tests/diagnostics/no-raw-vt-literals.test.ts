import { describe, expect, it } from "vitest";
import { inspectVtSource } from "../../tools/lint/check-no-raw-vt-literals.mjs";

const productionPath = "station/src/terminal/example.ts";

describe("no raw VT literals policy", () => {
  it("rejects raw ESC and BEL strings across escape spellings", () => {
    const source = String.raw`
      const a = "\x1b[?2004h";
      const b = "\u001b]10;value\u0007";
    `;

    expect(inspectVtSource(productionPath, source).map((item) => item.message)).toEqual([
      "raw ESC/BEL literal; use terminal/protocol typed vocabulary",
      "raw ESC/BEL literal; use terminal/protocol typed vocabulary",
    ]);
  });

  it("rejects distinctive mode values and inline parser identifiers", () => {
    const source = [
      "const mode = 2004;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must contain a template expression.
      "const cursorMode = `${VtPrefix.Csi}?${25}h`; const ansiMode = `${VtPrefix.Csi}${20}h`;",
      'terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, handler);',
      'terminal.parser.registerEscHandler({ final: "c" }, handler);',
      "terminal.parser.registerOscHandler(10, handler);",
    ].join("\n");

    expect(inspectVtSource(productionPath, source).map((item) => item.message)).toEqual([
      "raw terminal mode 2004; use AnsiMode or DecMode",
      "raw terminal mode 25; use AnsiMode or DecMode",
      "raw terminal mode 20; use AnsiMode or DecMode",
      "inline parser identifier; use CsiCommand or EscCommand",
      "inline parser identifier; use CsiCommand or EscCommand",
      "inline OSC command; use OscCommand",
    ]);
  });

  it("rejects protocol-internal imports from production leaves", () => {
    const source = `import { encodeCsiFunction } from "../protocol/internal/encode.js";`;
    expect(inspectVtSource(productionPath, source)[0]?.message).toBe(
      "protocol internal encoder imported outside terminal/protocol",
    );
  });

  it("allows canonical definitions, tests, parser regex, and unrelated numbers", () => {
    expect(
      inspectVtSource(
        "station/src/terminal/protocol/syntax.ts",
        String.raw`export const esc = "\x1b";`,
      ),
    ).toEqual([]);
    expect(
      inspectVtSource(
        "station/src/terminal/example.test.ts",
        String.raw`expect(value).toBe("\x1b[?2004h");`,
      ),
    ).toEqual([]);
    expect(
      inspectVtSource(
        productionPath,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must contain template expressions.
        'const parser = /^\\x1b\\[/; const timeoutMs = 1000; const year = "2026"; const cursor = `${VtPrefix.Csi}${row + 1};${column + 1}H`;',
      ),
    ).toEqual([]);
  });
});
