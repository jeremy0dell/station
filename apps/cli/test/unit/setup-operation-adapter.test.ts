import { emptyConfig } from "@station/config";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createHarnessTrackingAdapter } from "../../src/commands/setup/adapters/harnessTracking.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";

const opencodeOperation = {
  id: "prepare-harness-tracking:opencode",
  kind: "prepare-harness-tracking",
  tier: "required",
  selected: true,
  harnessId: "opencode",
} as const;

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

  it("sanitizes provider-native installation fields into commit evidence", async () => {
    const opencode = vi.fn(async () => ({
      provider: "opencode" as const,
      configDir: "/provider/config",
      pluginPath: "/provider/config/plugin.ts",
      changed: true,
      installed: true,
      before: "native before sentinel",
      after: "native after sentinel",
      backupPath: "/provider/config/plugin.ts.bak",
    }));
    const adapter = createHarnessTrackingAdapter({
      configPath: () => "/station/config.toml",
      homeDir: "/home/test",
      loadConfig: async () => ({
        configPath: "/station/config.toml",
        config: emptyConfig(),
        projects: [],
        diagnostics: [],
      }),
      runners: {
        claude: async () => {
          throw new Error("unused");
        },
        codex: async () => {
          throw new Error("unused");
        },
        cursor: async () => {
          throw new Error("unused");
        },
        opencode,
      },
    });

    const outcome = await adapter(opencodeOperation);

    expect(outcome).toEqual({
      status: "completed",
      operationId: opencodeOperation.id,
      commit: {
        kind: "provider-tracking",
        provider: "opencode",
        changed: true,
        backupPaths: ["/provider/config/plugin.ts.bak"],
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/native before|native after|pluginPath|configDir/);
    expect(opencode).toHaveBeenCalledWith(
      ["install", "--yes"],
      expect.objectContaining({ configPath: "/station/config.toml" }),
    );
  });

  it("normalizes unknown provider failures without raw data", async () => {
    const adapter = createHarnessTrackingAdapter({
      configPath: () => "/station/config.toml",
      homeDir: "/home/test",
      loadConfig: async () => ({
        configPath: "/station/config.toml",
        config: emptyConfig(),
        projects: [],
        diagnostics: [],
      }),
      runners: {
        claude: async () => {
          throw new Error("unused");
        },
        codex: async () => {
          throw new Error("unused");
        },
        cursor: async () => {
          throw new Error("unused");
        },
        opencode: async () => {
          throw new Error("raw provider sentinel");
        },
      },
    });

    const outcome = await adapter(opencodeOperation);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "SETUP_PROVIDER_TRACKING_FAILED",
        provider: "opencode",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("raw provider sentinel");
  });
});
