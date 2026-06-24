import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI OpenCode hook commands", () => {
  it("plans OpenCode plugin changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-opencode-hooks-"));
    const configPath = await writeConfig(root, true);
    const opencodeConfigDir = join(root, "opencode");
    const pluginPath = join(opencodeConfigDir, "plugins", "station-agent-state.js");

    const result = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "opencode",
      "--opencode-config-dir",
      opencodeConfigDir,
    ]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "opencode",
        changed: true,
        configDir: opencodeConfigDir,
        pluginPath,
      },
    });
    await expect(readFile(pluginPath, "utf8")).rejects.toThrow();
  });

  it("honors the --plugin-path override for the plugin location", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-opencode-hooks-"));
    const configPath = await writeConfig(root, true);
    const opencodeConfigDir = join(root, "opencode");
    const customPluginPath = join(root, "custom", "station-plugin.js");

    const result = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "opencode",
      "--opencode-config-dir",
      opencodeConfigDir,
      "--plugin-path",
      customPluginPath,
    ]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "opencode",
        pluginPath: customPluginPath,
      },
    });
  });

  it("requires explicit confirmation before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-opencode-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "opencode"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-opencode-hooks-"));
    const configPath = await writeConfig(root, true);
    const opencodeConfigDir = join(root, "opencode");
    const pluginPath = join(opencodeConfigDir, "plugins", "station-agent-state.js");

    const installed = await runCli([
      "--config",
      configPath,
      "hooks",
      "install",
      "opencode",
      "--yes",
      "--opencode-config-dir",
      opencodeConfigDir,
    ]);

    expect(installed).toMatchObject({
      code: 0,
      output: {
        provider: "opencode",
        installed: true,
        pluginPath,
      },
    });
    await expect(readFile(pluginPath, "utf8")).resolves.toContain(
      join(root, "run", "observer.sock"),
    );

    const uninstalled = await runCli([
      "--config",
      configPath,
      "hooks",
      "uninstall",
      "opencode",
      "--yes",
      "--opencode-config-dir",
      opencodeConfigDir,
    ]);

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "opencode",
        installed: false,
        removed: true,
      },
    });
    await expect(readFile(pluginPath, "utf8")).rejects.toThrow();
  });

  it("warns on doctor only when install_hooks requested OpenCode hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-opencode-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const opencodeConfigDir = join(root, "opencode");

    const requested = await runCli([
      "--config",
      requestedConfigPath,
      "hooks",
      "doctor",
      "opencode",
      "--opencode-config-dir",
      opencodeConfigDir,
    ]);
    const passive = await runCli([
      "--config",
      passiveConfigPath,
      "hooks",
      "doctor",
      "opencode",
      "--opencode-config-dir",
      opencodeConfigDir,
    ]);

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "opencode",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "opencode",
        status: "ok",
      },
    });
  });
});

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
      'harness = "opencode"',
      'layout = "agent-shell"',
      "",
      "[harness.opencode]",
      'command = "opencode"',
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}
