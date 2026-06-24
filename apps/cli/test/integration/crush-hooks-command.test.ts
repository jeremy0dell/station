import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI Crush hook commands", () => {
  it("plans Crush hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-crush-hooks-"));
    const configPath = await writeConfig(root, true);
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");

    const result = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "crush",
      "--crush-config",
      crushConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/stn-ingress",
    ]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "crush",
        changed: true,
        configPath: crushConfigPath,
        hookScriptPath,
      },
    });
    await expect(readFile(crushConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install and uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-crush-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "crush"])).rejects.toThrow(
      "without --yes",
    );
    await expect(runCli(["--config", configPath, "hooks", "uninstall", "crush"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-crush-hooks-"));
    const configPath = await writeConfig(root, true);
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");
    await writeFile(crushConfigPath, existingCrushConfig(), "utf8");

    const installed = await runCli([
      "--config",
      configPath,
      "hooks",
      "install",
      "crush",
      "--yes",
      "--crush-config",
      crushConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/stn-ingress",
    ]);

    expect(installed).toMatchObject({
      code: 0,
      output: {
        provider: "crush",
        installed: true,
        configPath: crushConfigPath,
        hookScriptPath,
      },
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(
      `/opt/stn-ingress --socket ${join(root, "run", "observer.sock")} --state-dir ${join(root, "state")} --spool-dir ${join(root, "state", "spool", "hooks")} --config`,
    );

    const uninstalled = await runCli([
      "--config",
      configPath,
      "hooks",
      "uninstall",
      "crush",
      "--yes",
      "--crush-config",
      crushConfigPath,
      "--hook-script",
      hookScriptPath,
    ]);

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "crush",
        installed: false,
        scriptRemoved: true,
      },
    });
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("warns on doctor only when install_hooks requested Crush hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-crush-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");

    const requested = await runCli([
      "--config",
      requestedConfigPath,
      "hooks",
      "doctor",
      "crush",
      "--crush-config",
      crushConfigPath,
      "--hook-script",
      hookScriptPath,
    ]);
    const passive = await runCli([
      "--config",
      passiveConfigPath,
      "hooks",
      "doctor",
      "crush",
      "--crush-config",
      crushConfigPath,
      "--hook-script",
      hookScriptPath,
    ]);

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "crush",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "crush",
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
      'harness = "crush"',
      'layout = "agent-shell"',
      "",
      "[harness.crush]",
      'command = "crush"',
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

function existingCrushConfig(): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [{ command: "echo existing", timeout: 5 }],
      },
    },
    null,
    2,
  );
}
