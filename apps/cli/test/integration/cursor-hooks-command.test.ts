import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI Cursor hook commands", () => {
  it("plans Cursor hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-cursor-hooks-"));
    const configPath = await writeConfig(root, true);
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");

    const result = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "cursor",
      "--cursor-hooks",
      hooksPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/stn-ingress",
    ]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "cursor",
        changed: true,
        hooksPath,
        hookScriptPath,
      },
    });
    await expect(readFile(hooksPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install and uninstall", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-cursor-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "cursor"])).rejects.toThrow(
      "without --yes",
    );
    await expect(runCli(["--config", configPath, "hooks", "uninstall", "cursor"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-cursor-hooks-"));
    const configPath = await writeConfig(root, true);
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    await mkdir(join(root, "cursor"), { recursive: true });
    await writeFile(hooksPath, existingCursorHooks(), "utf8");

    const installed = await runCli([
      "--config",
      configPath,
      "hooks",
      "install",
      "cursor",
      "--yes",
      "--cursor-hooks",
      hooksPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/stn-ingress",
    ]);

    expect(installed).toMatchObject({
      code: 0,
      output: {
        provider: "cursor",
        installed: true,
        hooksPath,
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
      "cursor",
      "--yes",
      "--cursor-hooks",
      hooksPath,
      "--hook-script",
      hookScriptPath,
    ]);

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "cursor",
        installed: false,
        scriptRemoved: true,
      },
    });
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("warns on doctor only when install_hooks requested Cursor hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-cursor-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");

    const requested = await runCli([
      "--config",
      requestedConfigPath,
      "hooks",
      "doctor",
      "cursor",
      "--cursor-hooks",
      hooksPath,
      "--hook-script",
      hookScriptPath,
    ]);
    const passive = await runCli([
      "--config",
      passiveConfigPath,
      "hooks",
      "doctor",
      "cursor",
      "--cursor-hooks",
      hooksPath,
      "--hook-script",
      hookScriptPath,
    ]);

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "cursor",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "cursor",
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
      'harness = "cursor"',
      'layout = "agent-shell"',
      "",
      "[harness.cursor]",
      'command = "agent"',
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

function existingCursorHooks(): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        afterShellExecution: [{ command: "echo existing", timeout: 5 }],
      },
    },
    null,
    2,
  );
}
