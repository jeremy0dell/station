import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { providerHookScriptRoutesByStationEnv } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("CLI Claude hook commands", () => {
  it("plans Claude hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-claude-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = claudeEnv(root);
    const claudeSettingsPath = join(root, "state", "hooks", "station-claude-settings.json");
    const hookScriptPath = join(root, "state", "hooks", "station-claude-hook.sh");

    const result = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "plan",
        "claude",
        "--claude-settings",
        claudeSettingsPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/stn-ingress",
      ],
      { env },
    );

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "claude",
        changed: true,
        settingsPath: claudeSettingsPath,
        userSettingsPath: join(root, "claude-home", "settings.json"),
        hookScriptPath,
      },
    });
    await expect(readFile(claudeSettingsPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-claude-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "claude"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-claude-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = claudeEnv(root);
    const claudeSettingsPath = join(root, "state", "hooks", "station-claude-settings.json");
    const userSettingsPath = join(root, "claude-home", "settings.json");
    const hookScriptPath = join(root, "state", "hooks", "station-claude-hook.sh");
    await mkdir(join(root, "claude-home"), { recursive: true });
    await writeFile(userSettingsPath, staleUserSettings(hookScriptPath), "utf8");

    const installed = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "claude",
        "--yes",
        "--claude-settings",
        claudeSettingsPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/stn-ingress",
      ],
      { env },
    );
    expect(installed).toMatchObject({
      code: 0,
      output: {
        provider: "claude",
        installed: true,
        settingsPath: claudeSettingsPath,
        userSettingsCleanup: {
          changed: true,
          stale: ["PreToolUse"],
        },
      },
    });
    const script = await readFile(hookScriptPath, "utf8");
    expect(providerHookScriptRoutesByStationEnv(script, "claude")).toBe(true);
    expect(script).toContain(`SOCKET_ARG=(--socket ${join(root, "run", "observer.sock")})`);
    expect(script).toContain(`STATE_DIR_ARG=(--state-dir ${join(root, "state")})`);
    expect(script).toContain(
      `SPOOL_DIR_ARG=(--spool-dir ${join(root, "state", "spool", "hooks")})`,
    );
    expect(script).toContain(`CONFIG_ARG=(--config ${configPath})`);
    await expect(readFile(claudeSettingsPath, "utf8")).resolves.toContain('"hooks"');
    await expect(readFile(userSettingsPath, "utf8")).resolves.not.toContain(hookScriptPath);

    await writeFile(userSettingsPath, staleUserSettings(hookScriptPath), "utf8");
    const uninstalled = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "uninstall",
        "claude",
        "--yes",
        "--claude-settings",
        claudeSettingsPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "claude",
        installed: false,
        settingsRemoved: true,
        scriptRemoved: true,
      },
    });
    await expect(readFile(claudeSettingsPath, "utf8")).rejects.toThrow();
    await expect(readFile(userSettingsPath, "utf8")).resolves.not.toContain(hookScriptPath);
  });

  it("warns on doctor only when install_hooks requested Claude hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-claude-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const env = claudeEnv(root);
    const claudeSettingsPath = join(root, "state", "hooks", "station-claude-settings.json");
    const hookScriptPath = join(root, "state", "hooks", "station-claude-hook.sh");

    const requested = await runCli(
      [
        "--config",
        requestedConfigPath,
        "hooks",
        "doctor",
        "claude",
        "--claude-settings",
        claudeSettingsPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );
    const passive = await runCli(
      [
        "--config",
        passiveConfigPath,
        "hooks",
        "doctor",
        "claude",
        "--claude-settings",
        claudeSettingsPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "claude",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "claude",
        status: "ok",
      },
    });
  });
});

function claudeEnv(root: string): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: join(root, "claude-home") };
}

async function writeConfig(root: string, installHooks: boolean): Promise<string> {
  const configPath = join(root, "config.toml");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(join(root, "state"))}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "claude"',
      'layout = "agent-shell"',
      "",
      "[harness.claude]",
      'command = "claude"',
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

function staleUserSettings(hookScriptPath: string): string {
  return JSON.stringify(
    {
      theme: "dark",
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: hookScriptPath,
                timeout: 30,
                statusMessage: "Notify station",
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}
