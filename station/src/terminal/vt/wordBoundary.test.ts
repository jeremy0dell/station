import { describe, expect, it } from "bun:test";
import { lineRangeAt, wordRangeAt } from "./wordBoundary.js";

describe("wordRangeAt", () => {
  const text = "  foo bar-baz  ";

  it("selects the word under the cursor", () => {
    expect(wordRangeAt(text, 3)).toEqual({ start: 2, end: 5 }); // "foo"
  });

  it("treats a hyphenated token as one word run (non-space class)", () => {
    expect(wordRangeAt(text, 8)).toEqual({ start: 6, end: 13 }); // "bar-baz"
  });

  it("selects a whitespace run when the cursor is on whitespace", () => {
    expect(wordRangeAt(text, 0)).toEqual({ start: 0, end: 2 });
  });

  it("clamps a past-the-end column to the last cell", () => {
    expect(wordRangeAt("ab", 99)).toEqual({ start: 0, end: 2 });
  });

  it("handles empty text", () => {
    expect(wordRangeAt("", 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("lineRangeAt", () => {
  it("spans the line without trailing whitespace", () => {
    expect(lineRangeAt("hello world   ")).toEqual({ start: 0, end: 11 });
  });

  it("is empty for a blank line", () => {
    expect(lineRangeAt("     ")).toEqual({ start: 0, end: 0 });
  });
});
