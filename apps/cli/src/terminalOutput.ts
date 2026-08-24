import type { CliRunResult } from "./cliTypes.js";

const unsafeTerminalBytePattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the CLI byte boundary.
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const unsafeJsonTerminalBytePattern =
  // JSON.stringify already escapes C0 values; this pattern preserves its structural whitespace.
  /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

/** Escapes terminal control and bidi code points without changing the represented JSON value. */
export function escapeTerminalBytes(value: string): string {
  return value.replace(
    unsafeTerminalBytePattern,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

export function formatCliJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    unsafeJsonTerminalBytePattern,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );
}

export function formatCliOutput(result: CliRunResult): string {
  if (result.outputFormat === "text") {
    const text = String(result.output ?? "");
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return `${formatCliJson(result.output)}\n`;
}
