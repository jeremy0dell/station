import { selectTuiFeatureFlags } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("TUI feature flag selectors", () => {
  it("treats missing feature flags as default evaluated client flags", () => {
    const snapshot = createDashboardSnapshot();

    expect(selectTuiFeatureFlags(snapshot)).toEqual({
      sessionResumeAgent: false,
    });
  });

  it("returns the evaluated client flag map from the observer snapshot", () => {
    const snapshot = {
      ...createDashboardSnapshot(),
      featureFlags: {
        revision: "test",
        flags: {
          sessionResumeAgent: true,
        },
      },
    };

    expect(selectTuiFeatureFlags(snapshot)).toEqual({
      sessionResumeAgent: true,
    });
  });
});
