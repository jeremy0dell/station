import type { ClaudeHookInstallResult } from "@station/claude";
import type { CodexHookInstallResult } from "@station/codex";
import { emptyConfig } from "@station/config";
import type { CursorHookInstallResult } from "@station/cursor";
import type { OpenCodePluginInstallResult } from "@station/opencode";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import type { SupportedHarnessId } from "@station/setup-core";
import { describe, expect, it } from "vitest";
import {
  createHarnessTrackingAdapter,
  type SetupHarnessTrackingRunners,
} from "../../src/commands/setup/adapters/harnessTracking.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";

const trackedProviders = ["claude", "codex", "cursor", "opencode"] as const;

describe("setup operation adapters", () => {
  it("streams genuine external installers through inherited stdio", async () => {
    const calls: ExternalCommandInput[] = [];
    const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
      calls.push(input);
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    };
    const execute = createSetupOperationAdapter({ deps: { runner, env: { PATH: "/bin" } } });

    await expect(
      execute({
        id: "install:tmux",
        kind: "install-tool",
        tier: "required",
        selected: true,
        tool: "tmux",
      }),
    ).resolves.toEqual({
      status: "completed",
      operationId: "install:tmux",
      commit: {
        kind: "package-installer",
        target: { kind: "tool", id: "tmux" },
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "brew",
        args: ["install", "tmux"],
        stdio: "inherit",
      }),
    ]);
  });

  it.each(
    trackedProviders,
  )("sanitizes %s installation fields into commit evidence", async (provider) => {
    const adapter = harnessTrackingAdapter(provider, false);
    const operation = trackingOperation(provider);

    const outcome = await adapter(operation);

    expect(outcome).toEqual({
      status: "completed",
      operationId: operation.id,
      commit: {
        kind: "provider-tracking",
        provider,
        changed: true,
        backupPaths: [`/provider/${provider}.bak`],
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(
      /native before sentinel|native after sentinel|hookScriptPath|pluginPath|configDir/,
    );
  });

  it.each(trackedProviders)("normalizes unknown %s failures without raw data", async (provider) => {
    const adapter = harnessTrackingAdapter(provider, true);
    const outcome = await adapter(trackingOperation(provider));

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "SETUP_PROVIDER_TRACKING_FAILED",
        provider,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("raw provider sentinel");
  });

  it("normalizes a rejected injected tracking port", async () => {
    const execute = createSetupOperationAdapter({
      deps: {
        providerTrackingPort: async () => {
          throw new Error("raw injected port sentinel");
        },
      },
    });

    const outcome = await execute(trackingOperation("opencode"));

    expect(outcome).toMatchObject({
      status: "failed",
      operationId: "prepare-harness-tracking:opencode",
      error: {
        code: "SETUP_PROVIDER_TRACKING_FAILED",
        provider: "opencode",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("raw injected port sentinel");
  });
});

function harnessTrackingAdapter(provider: (typeof trackedProviders)[number], fail: boolean) {
  return createHarnessTrackingAdapter({
    configPath: () => "/station/config.toml",
    homeDir: "/home/test",
    loadConfig: async () => ({
      configPath: "/station/config.toml",
      config: emptyConfig(),
      projects: [],
      diagnostics: [],
    }),
    runners: providerRunners(provider, fail),
  });
}

function providerRunners(
  provider: (typeof trackedProviders)[number],
  fail: boolean,
): SetupHarnessTrackingRunners {
  const rejected = () => {
    throw new Error(fail ? "raw provider sentinel" : "unused provider runner");
  };
  return {
    claude: async () => {
      if (provider !== "claude" || fail) return rejected();
      return providerInstallResult("claude");
    },
    codex: async () => {
      if (provider !== "codex" || fail) return rejected();
      return providerInstallResult("codex");
    },
    cursor: async () => {
      if (provider !== "cursor" || fail) return rejected();
      return providerInstallResult("cursor");
    },
    opencode: async () => {
      if (provider !== "opencode" || fail) return rejected();
      return providerInstallResult("opencode");
    },
  };
}

function providerInstallResult(provider: "claude"): ClaudeHookInstallResult;
function providerInstallResult(provider: "codex"): CodexHookInstallResult;
function providerInstallResult(provider: "cursor"): CursorHookInstallResult;
function providerInstallResult(provider: "opencode"): OpenCodePluginInstallResult;
function providerInstallResult(
  provider: (typeof trackedProviders)[number],
):
  | ClaudeHookInstallResult
  | CodexHookInstallResult
  | CursorHookInstallResult
  | OpenCodePluginInstallResult {
  const shared = {
    changed: true,
    installed: true,
    before: "native before sentinel",
    after: "native after sentinel",
  };
  switch (provider) {
    case "claude":
      return {
        ...shared,
        provider,
        settingsPath: "/provider/claude.json",
        userSettingsPath: "/provider/claude-user.json",
        hookScriptPath: "/provider/claude.sh",
        events: [],
        missing: [],
        settingsChanged: true,
        scriptChanged: true,
        artifactInvalid: false,
        userSettingsCleanup: {
          settingsPath: "/provider/claude-user.json",
          changed: false,
          stale: [],
          before: "",
          after: "",
        },
        backupPaths: ["/provider/claude.bak"],
      };
    case "codex":
      return {
        ...shared,
        provider,
        configPath: "/provider/codex.toml",
        profileName: "station",
        profileConfigPath: "/provider/codex-profile.toml",
        baseConfigPath: "/provider/codex-base.toml",
        hookScriptPath: "/provider/codex.sh",
        commands: {} as CodexHookInstallResult["commands"],
        missing: [],
        configChanged: true,
        generatedGlobalChanged: false,
        scriptChanged: true,
        generatedGlobalCleanup: {
          configPath: "/provider/codex-base.toml",
          changed: false,
          stale: [],
          before: "",
          after: "",
        },
        backupPaths: ["/provider/codex.bak"],
      };
    case "cursor":
      return {
        ...shared,
        provider,
        hooksPath: "/provider/cursor.json",
        hookScriptPath: "/provider/cursor.sh",
        commands: {} as CursorHookInstallResult["commands"],
        missing: [],
        configChanged: true,
        scriptChanged: true,
        backupPaths: ["/provider/cursor.bak"],
      };
    case "opencode":
      return {
        ...shared,
        provider,
        configDir: "/provider/opencode",
        pluginPath: "/provider/opencode/plugin.ts",
        backupPath: "/provider/opencode.bak",
      };
  }
}

function trackingOperation(harnessId: SupportedHarnessId) {
  return {
    id: `prepare-harness-tracking:${harnessId}` as const,
    kind: "prepare-harness-tracking" as const,
    tier: "required" as const,
    selected: true as const,
    harnessId,
  };
}
