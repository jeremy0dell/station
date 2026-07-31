import { describe, expect, it } from "vitest";
import { parseMultiSelectAnswer } from "../../src/commands/setup/io.js";

describe("setup prompt input", () => {
  const choices = [
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
    { value: "pi", label: "Pi" },
  ];

  it("preserves comma-separated selection order while ignoring duplicates and invalid slots", () => {
    expect(parseMultiSelectAnswer("3, 1,3,99,nope", choices)).toEqual(["pi", "codex"]);
  });

  it("returns no selection when no valid slot was selected", () => {
    expect(parseMultiSelectAnswer("", choices)).toEqual([]);
    expect(parseMultiSelectAnswer("99", choices)).toEqual([]);
    expect(parseMultiSelectAnswer("nope", choices)).toEqual([]);
  });
});
