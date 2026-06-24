import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyDiagnosticEvidenceIndex } from "../../oracles/diagnosticOracle";

type Scenario = {
  name: string;
  expectedRootCause: string;
  evidenceIndex: unknown;
};

const scenarioDir = fileURLToPath(new URL(".", import.meta.url));

describe("diagnostic oracle scenarios", () => {
  it("classifies all deterministic diagnosis fixtures", async () => {
    const files = (await readdir(scenarioDir)).filter((file) => file.endsWith(".json")).sort();
    const scenarios = await Promise.all(
      files.map(
        async (file) => JSON.parse(await readFile(join(scenarioDir, file), "utf8")) as Scenario,
      ),
    );

    expect(scenarios.map((scenario) => scenario.name)).toEqual(
      expect.arrayContaining([
        "missing-worktrunk-binary",
        "stale-terminal-target",
        "invalid-config",
        "hook-spool-fallback",
        "provider-timeout",
        "harness-unexpected-exit",
        "sqlite-write-failure",
      ]),
    );

    for (const scenario of scenarios) {
      expect(classifyDiagnosticEvidenceIndex(scenario.evidenceIndex), scenario.name).toMatchObject({
        rootCause: scenario.expectedRootCause,
        confidence: expect.stringMatching(/^(high|medium|low)$/),
      });
    }
  });
});
