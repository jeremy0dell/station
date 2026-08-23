import { describe, expect, it } from "vitest";
import { encodeUpdateTerminalText } from "../../src/update/updateTerminalText.js";

describe("update terminal text encoding", () => {
  it("encodes line breaks, C0, C1, OSC, CSI, and Unicode line separators", () => {
    const input =
      "line\n\u0000\u0007\u001b]0;title\u0007\u001b[31m\u007f\u0085\u009b31m\u2028\u2029tail";

    expect(encodeUpdateTerminalText(input)).toBe(
      "line\\u000a\\u0000\\u0007\\u001b]0;title\\u0007\\u001b[31m\\u007f\\u0085\\u009b31m\\u2028\\u2029tail",
    );
  });

  it("preserves safe digest, build identity, and astral Unicode text", () => {
    const digest = "a".repeat(64);
    const build = `1.2.3+station.${"b".repeat(64)}`;
    const input = `${digest} ${build} terminal-😀`;

    expect(encodeUpdateTerminalText(input)).toBe(input);
  });
});
