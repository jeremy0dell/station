import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SETUP_HARNESS_DEFINITIONS,
  setupHarnessDefinitions,
} from "../../src/commands/setup/harnessDefinitions.js";

describe("setup harness definitions", () => {
  it("pins the complete CLI metadata and canonical fact order", () => {
    const metadata = setupHarnessDefinitions.map(
      ({ id, label, envKey, command, guidedRank, tracking, trackingNeedsIngressLauncher }) =>
        [id, label, envKey, command, guidedRank, tracking, trackingNeedsIngressLauncher].join("|"),
    );

    expect(metadata).toEqual([
      "codex|Codex|STATION_CODEX_BIN|codex|1|external|true",
      "cursor|Cursor Agent|STATION_CURSOR_AGENT_BIN|agent|2|external|true",
      "opencode|OpenCode|STATION_OPENCODE_BIN|opencode|3|external|false",
      "pi|Pi|STATION_PI_BIN|pi|4|none|false",
      "claude|Claude Code|STATION_CLAUDE_BIN|claude|0|external|true",
    ]);
    expect(Object.keys(SETUP_HARNESS_DEFINITIONS)).toEqual([
      "codex",
      "cursor",
      "opencode",
      "pi",
      "claude",
    ]);
  });

  it("pins the guided harness order independently from fact order", () => {
    expect(
      [...setupHarnessDefinitions]
        .sort((left, right) => left.guidedRank - right.guidedRank)
        .map(({ id }) => id),
    ).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
  });

  it("keeps setup-owned harness metadata behind the canonical definitions", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const checks = source("../../src/commands/setup/checks/harnesses.ts");
    const inspection = source("../../src/commands/setup/adapters/inspection.ts");
    const guided = source("../../src/commands/setup/session/runGuidedSetupSession.ts");
    const result = source("../../src/commands/setup/presentation/projectSetupResult.ts");
    const json = source("../../src/commands/setup/presenters/json.ts");

    expect(checks).not.toContain("STATION_CURSOR_AGENT_BIN");
    expect(checks).not.toContain('label: "Claude Code"');
    expect(inspection).not.toContain('harnessId !== "pi"');
    expect(guided).not.toContain('["claude", "codex", "cursor", "opencode", "pi"]');
    expect(result).not.toContain('harnessId === "claude"');
    expect(json).not.toContain('harness === "claude"');
  });
});
