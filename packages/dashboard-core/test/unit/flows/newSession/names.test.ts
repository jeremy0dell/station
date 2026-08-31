import { describe, expect, it } from "vitest";
import { createNewSessionNameToken } from "../../../../src/flows/newSession/names.js";

describe("New Session names", () => {
  it("creates deterministic path-safe name tokens from unique sources", () => {
    expect(createNewSessionNameToken("source-a")).toMatch(/^[a-f0-9]{6}$/);
    expect(createNewSessionNameToken("source-a")).toBe(createNewSessionNameToken("source-a"));
    expect(createNewSessionNameToken("source-a")).not.toBe(createNewSessionNameToken("source-b"));
  });
});
