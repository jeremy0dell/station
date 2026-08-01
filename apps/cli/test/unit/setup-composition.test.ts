import { describe, expect, it } from "vitest";
import { createSetupComposition } from "../../src/commands/setup/composition.js";

describe("setup composition", () => {
  it("creates one invocation-scoped session without inspecting or mutating during construction", () => {
    const composition = createSetupComposition({
      mode: "check",
      options: {},
      deps: {},
      noBrew: false,
      planConfigWrite: false,
    });

    expect(composition.session.application.getState()).toMatchObject({
      status: "inspecting",
      inspectionPhase: "initial",
    });
    expect(composition.session.snapshot()).toBeUndefined();
    expect(typeof composition.json.project).toBe("function");
  });
});
