import {
  backWizardStep,
  createStepWizardState,
  enterWizardStep,
  resetWizardStep,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("step wizard helpers", () => {
  it("tracks step history without owning domain state", () => {
    const started = {
      ...createStepWizardState<"review" | "details" | "confirm">("review"),
      value: "draft",
    };

    const details = enterWizardStep(started, "details");
    const confirm = enterWizardStep(details, "confirm");

    expect(confirm).toEqual({
      mode: "confirm",
      stepHistory: ["review", "details"],
      value: "draft",
    });
    expect(backWizardStep(confirm)).toEqual({
      mode: "details",
      stepHistory: ["review"],
      value: "draft",
    });
  });

  it("closes at the root step and resets after commits", () => {
    const started = createStepWizardState<"review" | "details">("review");
    const details = enterWizardStep(started, "details");

    expect(backWizardStep(started)).toBeUndefined();
    expect(resetWizardStep(details, "review")).toEqual({
      mode: "review",
      stepHistory: [],
    });
  });
});
