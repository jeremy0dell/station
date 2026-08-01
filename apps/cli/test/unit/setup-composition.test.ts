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

  it("projects inspection diagnostics even when collection produced no snapshot", async () => {
    const inspectionError = {
      tag: "SyntheticInspectionError",
      code: "SYNTHETIC_INSPECTION_FAILED",
      message: "Synthetic inspection failed.",
      hint: "Repair the synthetic fixture.",
    };
    const composition = createSetupComposition({
      mode: "check",
      options: {},
      deps: {
        now: () => {
          throw inspectionError;
        },
      },
      noBrew: false,
      planConfigWrite: false,
    });

    const state = await composition.session.application.review();

    expect(composition.session.snapshot()).toBeUndefined();
    expect(composition.project(state)).toEqual({
      status: "unavailable",
      error: inspectionError,
    });
  });

  it("keeps inspection snapshots isolated between CLI invocations", () => {
    const first = createSetupComposition({
      mode: "check",
      options: {},
      deps: {},
      noBrew: false,
      planConfigWrite: false,
    });
    const second = createSetupComposition({
      mode: "check",
      options: {},
      deps: {},
      noBrew: false,
      planConfigWrite: false,
    });

    expect(first.session.application).not.toBe(second.session.application);
    expect(first.session.snapshot()).toBeUndefined();
    expect(second.session.snapshot()).toBeUndefined();
  });
});
