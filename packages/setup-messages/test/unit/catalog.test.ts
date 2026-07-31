import { describe, expect, it } from "vitest";
import { type SetupMessageCatalog, setupMessageCatalog, setupMessageIds } from "../../src/index.js";

describe("setup message catalog", () => {
  it("has one non-empty terminal variant for every public message id", () => {
    expect([...setupMessageIds].sort()).toEqual(Object.keys(setupMessageCatalog).sort());
    expect(new Set(setupMessageIds).size).toBe(setupMessageIds.length);

    const catalog: SetupMessageCatalog = setupMessageCatalog;
    for (const definition of Object.values(catalog)) {
      expect(definition.terminal.trim().length).toBeGreaterThan(0);
      if (definition.graphical !== undefined) {
        expect(definition.graphical.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
