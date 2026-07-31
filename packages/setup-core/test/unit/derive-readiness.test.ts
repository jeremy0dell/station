import { describe, expect, it } from "vitest";
import { deriveSetupReadiness, type SetupReadinessFacts } from "../../src/index.js";

describe("deriveSetupReadiness", () => {
  it.each([
    {
      name: "compiled runtime with writable state",
      facts: readiness({ runtime: { kind: "compiled" } }),
      launchReady: true,
    },
    {
      name: "compiled runtime with unwritable state",
      facts: readiness({ stateDirectoryWritable: false, runtime: { kind: "compiled" } }),
      launchReady: false,
    },
    {
      name: "complete source runtime",
      facts: readiness({
        runtime: { kind: "source", bunAvailable: true, stationUiUsable: true },
      }),
      launchReady: true,
    },
    {
      name: "source runtime without Bun",
      facts: readiness({
        runtime: { kind: "source", bunAvailable: false, stationUiUsable: true },
      }),
      launchReady: false,
    },
    {
      name: "source runtime without a usable UI",
      facts: readiness({
        runtime: { kind: "source", bunAvailable: true, stationUiUsable: false },
      }),
      launchReady: false,
    },
  ])("derives launch readiness for $name", ({ facts, launchReady }) => {
    expect(deriveSetupReadiness(facts).launchReady).toBe(launchReady);
  });

  it("derives workflow readiness and the exact missing count from requirements", () => {
    expect(
      deriveSetupReadiness(
        readiness({ requirements: ["satisfied", "unsatisfied", "satisfied", "unsatisfied"] }),
      ),
    ).toEqual({ launchReady: true, workflowReady: false, requiredMissing: 2 });
    expect(deriveSetupReadiness(readiness({ requirements: [] }))).toEqual({
      launchReady: true,
      workflowReady: true,
      requiredMissing: 0,
    });
  });
});

function readiness(overrides: Partial<SetupReadinessFacts> = {}): SetupReadinessFacts {
  return {
    stateDirectoryWritable: true,
    runtime: { kind: "compiled" },
    requirements: ["satisfied"],
    ...overrides,
  };
}
