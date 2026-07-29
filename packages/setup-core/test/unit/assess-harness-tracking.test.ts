import { describe, expect, it } from "vitest";
import { assessHarnessTracking, type HarnessTrackingFacts } from "../../src/index.js";

describe("assessHarnessTracking", () => {
  it("classifies unsupported capability as not applicable", () => {
    expect(
      assessHarnessTracking({
        capability: "unsupported",
        configRequested: true,
        evidence: { availability: "unavailable" },
      }),
    ).toEqual({ state: "not-applicable" });
  });

  it.each([
    {
      name: "unavailable evidence",
      facts: supported({ availability: "unavailable" }),
      expected: { state: "probe-failed" },
    },
    {
      name: "failed probe with evidence",
      facts: supported({
        availability: "available",
        requested: true,
        installed: false,
        probeFailed: true,
      }),
      expected: { state: "probe-failed", requested: true, installed: false },
    },
    {
      name: "config intent disabled",
      facts: supported(
        { availability: "available", requested: true, installed: true, probeFailed: false },
        false,
      ),
      expected: { state: "disabled", requested: true, installed: true },
    },
    {
      name: "provider intent disabled",
      facts: supported({ availability: "available", requested: false, probeFailed: false }),
      expected: { state: "disabled", requested: false },
    },
    {
      name: "artifact absent or drifted",
      facts: supported({
        availability: "available",
        requested: true,
        installed: false,
        probeFailed: false,
      }),
      expected: {
        state: "artifact-missing-or-drifted",
        requested: true,
        installed: false,
      },
    },
    {
      name: "prepared",
      facts: supported({
        availability: "available",
        requested: true,
        installed: true,
        probeFailed: false,
      }),
      expected: { state: "prepared", requested: true, installed: true },
    },
  ])("classifies $name", ({ facts, expected }) => {
    expect(assessHarnessTracking(facts)).toEqual(expected);
  });

  it("preserves absent optional evidence fields", () => {
    const failed = assessHarnessTracking(
      supported({ availability: "available", probeFailed: true }),
    );
    expect(failed).toEqual({ state: "probe-failed" });
    expect("requested" in failed).toBe(false);
    expect("installed" in failed).toBe(false);

    const missing = assessHarnessTracking(
      supported({ availability: "available", requested: true, probeFailed: false }),
    );
    expect(missing).toEqual({ state: "artifact-missing-or-drifted", requested: true });
    expect("installed" in missing).toBe(false);
  });
});

function supported(
  evidence: HarnessTrackingFacts["evidence"],
  configRequested = true,
): HarnessTrackingFacts {
  return { capability: "supported", configRequested, evidence };
}
