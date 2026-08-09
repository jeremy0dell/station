import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVIDER_HOOK_DEFINITIONS } from "../../src/commands/providerHookDefinitions.js";
import {
  SETUP_HARNESS_DEFINITIONS,
  setupHarnessDefinitions,
} from "../../src/commands/setup/harnessDefinitions.js";

describe("setup harness definitions", () => {
  it("pins the complete CLI metadata and canonical fact order", () => {
    const metadata = setupHarnessDefinitions.map(
      ({
        id,
        displayName,
        label,
        commandEnvVar,
        commandFallback,
        guidedRank,
        additionalUserCommandDirectories,
        providerHook,
      }) =>
        [
          id,
          displayName,
          label,
          commandEnvVar,
          commandFallback,
          guidedRank,
          additionalUserCommandDirectories?.join(",") ?? "none",
          providerHook === undefined ? "none" : "external",
          providerHook?.supportsHookBin ?? false,
        ].join("|"),
    );

    expect(metadata).toEqual([
      "codex|Codex|Codex|STATION_CODEX_BIN|codex|1|none|external|true",
      "cursor|Cursor|Cursor Agent|STATION_CURSOR_AGENT_BIN|agent|2|none|external|true",
      "opencode|OpenCode|OpenCode|STATION_OPENCODE_BIN|opencode|3|.opencode/bin|external|false",
      "pi|Pi|Pi|STATION_PI_BIN|pi|4|none|none|false",
      "claude|Claude Code|Claude Code|STATION_CLAUDE_BIN|claude|0|none|external|true",
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

  it("keeps provider-hook capabilities in the provider-hook registry", () => {
    expect(PROVIDER_HOOK_DEFINITIONS).toEqual({
      worktrunk: {
        id: "worktrunk",
        providerConfigFlag: "--worktrunk-config",
        supportsHookScript: false,
        supportsHookBin: true,
      },
      claude: {
        id: "claude",
        providerConfigFlag: "--claude-settings",
        supportsHookScript: true,
        supportsHookBin: true,
      },
      codex: {
        id: "codex",
        providerConfigFlag: "--codex-config",
        supportsHookScript: true,
        supportsHookBin: true,
      },
      cursor: {
        id: "cursor",
        providerConfigFlag: "--cursor-hooks",
        supportsHookScript: true,
        supportsHookBin: true,
      },
      opencode: {
        id: "opencode",
        providerConfigFlag: "--opencode-config-dir",
        supportsHookScript: true,
        supportsHookBin: false,
        hookScriptFlag: "--plugin-path",
      },
    });
    expect("providerHook" in SETUP_HARNESS_DEFINITIONS.pi).toBe(false);
  });

  it("keeps setup-owned harness metadata behind the canonical definitions", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const checks = source("../../src/commands/setup/checks/harnesses.ts");
    const inspection = source("../../src/commands/setup/adapters/inspection.ts");
    const guided = source("../../src/commands/setup/session/runGuidedSetupSession.ts");
    const result = source("../../src/commands/setup/presentation/projectSetupResult.ts");
    const json = source("../../src/commands/setup/presenters/json.ts");
    const definitions = source("../../src/commands/setup/harnessDefinitions.ts");
    const operations = source("../../src/commands/setup/adapters/operations.ts");
    const actions = source("../../src/commands/setup/presentation/projectSetupActions.ts");
    const hookAdapters = source("../../src/commands/providerHookAdapters.ts");

    expect(checks).not.toContain("STATION_CURSOR_AGENT_BIN");
    expect(checks).not.toContain('label: "Claude Code"');
    expect(inspection).not.toContain('harnessId !== "pi"');
    expect(checks).not.toContain('id === "opencode"');
    expect(guided).not.toContain('["claude", "codex", "cursor", "opencode", "pi"]');
    expect(result).not.toContain('harnessId === "claude"');
    expect(json).not.toContain('harness === "claude"');
    expect(definitions).not.toContain("STATION_CODEX_BIN");
    expect(operations).not.toContain("homebrew/cask/codex");
    expect(actions).not.toContain("installer.codex-brew");
    expect(hookAdapters).not.toContain("supportsHookBin: true");
  });
});
