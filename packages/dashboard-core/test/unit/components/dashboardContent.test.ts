import { describe, expect, it } from "vitest";
import { commandPromptForScreen } from "../../../src/components/Dashboard/content.js";

describe("dashboard semantic content", () => {
  it("describes the rename chooser prompt without physical placement", () => {
    expect(commandPromptForScreen({ name: "renameSession", step: "chooseSlot" })).toEqual({
      text: "Rename: ↑↓ move · ↵ choose · 1-9/a-z or click",
      tone: "warning",
    });
  });

  it("omits a prompt when the active screen owns its own content", () => {
    expect(commandPromptForScreen({ name: "dashboard" })).toBeUndefined();
  });
});
