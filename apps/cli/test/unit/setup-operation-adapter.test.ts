import { dirname } from "node:path";
import type { ClaudeHookInstallResult } from "@station/claude";
import type { CodexHookInstallResult } from "@station/codex";
import { emptyConfig } from "@station/config";
import type { CliSetupHarnessId } from "@station/contracts";
import type { CursorHookInstallResult } from "@station/cursor";
import type { OpenCodePluginInstallResult } from "@station/opencode";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { setupConfigMutationInput } from "../../src/commands/setup/adapters/config.js";
import {
  createHarnessTrackingAdapter,
  type SetupHarnessTrackingRunners,
} from "../../src/commands/setup/adapters/harnessTracking.js";
import type { SetupFacts } from "../../src/commands/setup/adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";
import {
  tmuxPopupBindingMarker,
  tmuxPopupRunShellCommand,
} from "../../src/commands/setup/checks/tmuxBinding.js";
import type { SetupCommandDeps } from "../../src/commands/setup/types.js";

const trackedProviders = ["claude", "codex", "cursor", "opencode"] as const;

describe("setup operation adapters", () => {
  it("uses the resolved executable when setup creates a harness config block", () => {
    const input = setupConfigMutationInput(
      {
        id: "write-config",
        kind: "write-config",
        tier: "required",
        selected: true,
        change: "create",
        defaultHarnessId: "pi",
        harnessIds: ["pi"],
        trackingHarnessIds: [],
        installWorktrunkTracking: false,
      },
      {
        homeDir: "/home/test",
        config: { status: "missing", path: "/home/test/.config/station/config.toml" },
        worktrunk: { status: "ok", command: "wt", resolvedPath: "/opt/tools/wt" },
        tmux: { status: "ok", command: "tmux", resolvedPath: "/opt/tools/tmux" },
        harnesses: [
          {
            id: "pi",
            label: "Pi",
            status: "ok",
            command: "pi",
            resolvedPath: "/opt/tools/pi",
          },
        ],
      } as SetupFacts,
    );

    expect(input.desired.harnesses).toEqual([
      { id: "pi", command: "/opt/tools/pi", installHooks: false },
    ]);
  });

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

  it("revalidates persisted tmux conflicts immediately before mutation", async () => {
    const tmuxConfigPath = "/tmp/station-tmux-precondition/.tmux.conf";
    const writes: string[] = [];
    const execute = createSetupOperationAdapter({
      facts: tmuxFacts({ path: tmuxConfigPath, insideTmux: false, liveStatus: "unknown" }),
      deps: {
        env: { PATH: "/bin" },
        fs: tmuxOperationFs({
          readFile: async () => 'bind-key "Space" display-message "user action"\n',
          writeFile: async (path) => {
            writes.push(path);
          },
        }),
      },
    });

    const outcome = await execute({
      id: "persist-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: true,
      scope: "persisted",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "SETUP_TMUX_CONFLICT", message: expect.stringContaining("will not replace") },
    });
    expect(writes).toEqual([]);
  });

  it("refuses tmux replacement when admitted config bytes change before rename", async () => {
    const tmuxConfigPath = "/tmp/station-tmux-replacement/.tmux.conf";
    const initialConfig = "set -g mouse on\n";
    let reads = 0;
    let renamed = false;
    const execute = createSetupOperationAdapter({
      facts: tmuxFacts({ path: tmuxConfigPath, insideTmux: false, liveStatus: "unknown" }),
      deps: {
        env: { PATH: "/bin" },
        now: () => new Date("2026-06-08T12:00:00.000Z"),
        fs: tmuxOperationFs({
          readFile: async () => {
            reads += 1;
            return reads === 1
              ? initialConfig
              : 'bind-key "Space" display-message "late user action"\n';
          },
          rename: async () => {
            renamed = true;
          },
        }),
      },
    });

    const outcome = await execute({
      id: "persist-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: true,
      scope: "persisted",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "SETUP_TMUX_WRITE_FAILED" },
    });
    expect(reads).toBe(2);
    expect(renamed).toBe(false);
  });

  it("revalidates live tmux conflicts immediately before mutation", async () => {
    const calls: ExternalCommandInput[] = [];
    const execute = createSetupOperationAdapter({
      facts: tmuxFacts({
        path: "/tmp/station-tmux-live-precondition/.tmux.conf",
        insideTmux: true,
        liveStatus: "missing",
      }),
      deps: {
        env: { PATH: "/bin", TMUX: "/tmp/tmux.sock,1,0" },
        runner: async (input) => {
          calls.push(input);
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: 'bind-key -T prefix Space display-message "user action"\n',
            stderr: "",
            exitCode: 0,
          };
        },
        fs: tmuxOperationFs(),
      },
    });

    const outcome = await execute({
      id: "load-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: true,
      scope: "live",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "SETUP_TMUX_CONFLICT", message: expect.stringContaining("will not replace") },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args?.[0]).toBe("list-keys");
  });

  it("leaves a live tmux binding unchanged when revalidation is unavailable", async () => {
    const calls: ExternalCommandInput[] = [];
    const execute = createSetupOperationAdapter({
      facts: tmuxFacts({
        path: "/tmp/station-tmux-live-unknown/.tmux.conf",
        insideTmux: true,
        liveStatus: "missing",
      }),
      deps: {
        env: { PATH: "/bin", TMUX: "/tmp/tmux.sock,1,0" },
        runner: async (input) => {
          calls.push(input);
          throw new Error("tmux evidence unavailable");
        },
        fs: tmuxOperationFs(),
      },
    });

    const outcome = await execute({
      id: "load-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: true,
      scope: "live",
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "SETUP_TMUX_CONFLICT",
        message: expect.stringContaining("could not be revalidated"),
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps a missing shell rc precondition inside the Worktrunk adapter", async () => {
    let runnerCalls = 0;
    const execute = createSetupOperationAdapter({
      facts: {
        homeDir: "/tmp/station-shell-precondition",
        worktrunk: { status: "ok", command: "wt" },
        worktrunkShellIntegration: {
          status: "warning",
          message: "missing",
          shell: "zsh",
          rcPath: "/tmp/station-shell-precondition/does-not-exist/.zshrc",
        },
      } as SetupFacts,
      deps: {
        runner: async (input) => {
          runnerCalls += 1;
          return {
            command: input.command,
            args: input.args ?? [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    const outcome = await execute({
      id: "configure-worktrunk-shell",
      kind: "configure-worktrunk-shell",
      tier: "recommended",
      selected: true,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "SETUP_WORKTRUNK_SHELL_RC_MISSING" },
    });
    expect(runnerCalls).toBe(0);
  });

  it.each(
    trackedProviders,
  )("sanitizes %s installation fields into commit evidence", async (provider) => {
    const adapter = harnessTrackingAdapter({ provider, fail: false });
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
    const adapter = harnessTrackingAdapter({ provider, fail: true });
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

function tmuxOperationFs(
  overrides: Partial<NonNullable<SetupCommandDeps["fs"]>> = {},
): NonNullable<SetupCommandDeps["fs"]> {
  return {
    async readFile(path) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
    async rename() {},
    async access(path) {
      throw Object.assign(new Error(`Missing file: ${path}`), { code: "ENOENT" });
    },
    ...overrides,
  };
}

function tmuxFacts(input: {
  readonly path: string;
  readonly insideTmux: boolean;
  readonly liveStatus: "loaded" | "missing" | "unknown";
}): SetupFacts {
  const launcherCommand = "/tmp/bin/stn-tmux-popup";
  return {
    homeDir: dirname(input.path),
    tmux: { status: "ok", command: "tmux", resolvedPath: "/bin/tmux" },
    tmuxBinding: {
      status: "missing",
      path: input.path,
      marker: tmuxPopupBindingMarker,
      launcherCommand,
      runShellCommand: tmuxPopupRunShellCommand(launcherCommand),
      bindingKey: "Space",
      insideTmux: input.insideTmux,
      liveStatus: input.liveStatus,
      message: "Optional tmux popup binding is not installed.",
    },
  } as SetupFacts;
}

function harnessTrackingAdapter(input: {
  readonly provider: (typeof trackedProviders)[number];
  readonly fail: boolean;
}) {
  return createHarnessTrackingAdapter({
    configPath: () => "/station/config.toml",
    homeDir: "/home/test",
    loadConfig: async () => ({
      configPath: "/station/config.toml",
      config: emptyConfig(),
      projects: [],
      diagnostics: [],
    }),
    runners: providerRunners(input),
  });
}

function providerRunners(input: {
  readonly provider: (typeof trackedProviders)[number];
  readonly fail: boolean;
}): SetupHarnessTrackingRunners {
  const rejected = () => {
    throw new Error(input.fail ? "raw provider sentinel" : "unused provider runner");
  };
  return {
    claude: async () => {
      if (input.provider !== "claude" || input.fail) return rejected();
      return providerInstallResult("claude");
    },
    codex: async () => {
      if (input.provider !== "codex" || input.fail) return rejected();
      return providerInstallResult("codex");
    },
    cursor: async () => {
      if (input.provider !== "cursor" || input.fail) return rejected();
      return providerInstallResult("cursor");
    },
    opencode: async () => {
      if (input.provider !== "opencode" || input.fail) return rejected();
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
  if (provider === "claude") {
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
  }
  if (provider === "codex") {
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
  }
  if (provider === "cursor") {
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
  }
  return {
    ...shared,
    provider,
    configDir: "/provider/opencode",
    pluginPath: "/provider/opencode/plugin.ts",
    backupPath: "/provider/opencode.bak",
  };
}

function trackingOperation(harnessId: CliSetupHarnessId) {
  return {
    id: `prepare-harness-tracking:${harnessId}` as const,
    kind: "prepare-harness-tracking" as const,
    tier: "required" as const,
    selected: true as const,
    harnessId,
  };
}
