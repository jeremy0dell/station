import type { FeatureFlagDefinitionsMap } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  createFeatureFlagEvaluator,
  createFeatureFlagEvaluatorForDefinitions,
} from "../../src/features/evaluator";

const testDefinitions = {
  "test.clientFlag": {
    defaultValue: false,
    exposure: "client",
    owner: "tui",
    surfaces: ["tui"],
    lifecycle: "temporary",
    summary: "Test-only client flag.",
  },
  "test.serverFlag": {
    defaultValue: true,
    exposure: "server",
    owner: "observer",
    surfaces: ["observer"],
    lifecycle: "temporary",
    summary: "Test-only server flag.",
  },
} as const satisfies FeatureFlagDefinitionsMap;

describe("observer feature flag evaluator", () => {
  it("defaults production flags to conservative values", () => {
    const evaluator = createFeatureFlagEvaluator({ revisionSeed: "test" });

    expect(evaluator.all().flags).toEqual({
      sessionResumeAgent: false,
      stationPersistentAgents: false,
    });
    expect(evaluator.clientSnapshot().flags).toEqual({
      sessionResumeAgent: false,
    });
  });

  it("evaluates local definitions from defaults plus overrides", () => {
    const evaluator = createFeatureFlagEvaluatorForDefinitions({
      definitions: testDefinitions,
      overrides: {
        "test.clientFlag": true,
      },
      revisionSeed: "test",
    });

    expect(evaluator.enabled("test.clientFlag")).toBe(true);
    expect(evaluator.enabled("test.serverFlag")).toBe(true);
    expect(evaluator.all().flags).toEqual({
      "test.clientFlag": true,
      "test.serverFlag": true,
    });
  });

  it("exposes only client flags in the client snapshot", () => {
    const evaluator = createFeatureFlagEvaluatorForDefinitions({
      definitions: testDefinitions,
      overrides: {
        "test.clientFlag": true,
        "test.serverFlag": false,
      },
      revisionSeed: "test",
    });

    expect(evaluator.clientSnapshot()).toEqual({
      revision: evaluator.all().revision,
      flags: {
        "test.clientFlag": true,
      },
    });
  });
});
