import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { providerHookScriptRoutesByStationEnv } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("CLI Codex hook commands", () => {
  it("plans Codex hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const result = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "plan",
        "codex",
        "--codex-config",
        codexConfigPath,
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
        provider: "codex",
        changed: true,
        configPath: codexConfigPath,
        profileName: "station",
        profileConfigPath: codexConfigPath,
        baseConfigPath,
        hookScriptPath,
      },
    });
    await expect(readFile(codexConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "codex"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    const installed = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
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
        provider: "codex",
        installed: true,
        profileConfigPath: codexConfigPath,
        baseConfigPath,
        generatedGlobalCleanup: {
          changed: true,
          stale: ["PreToolUse"],
        },
      },
    });
    const script = await readFile(hookScriptPath, "utf8");
    expect(providerHookScriptRoutesByStationEnv(script, "codex")).toBe(true);
    expect(script).toContain(`SOCKET_ARG=(--socket ${join(root, "run", "observer.sock")})`);
    expect(script).toContain(`STATE_DIR_ARG=(--state-dir ${join(root, "state")})`);
    expect(script).toContain(
      `SPOOL_DIR_ARG=(--spool-dir ${join(root, "state", "spool", "hooks")})`,
    );
    expect(script).toContain(`CONFIG_ARG=(--config ${configPath})`);
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain(hookScriptPath);
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");
    const uninstalled = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "uninstall",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        installed: false,
        generatedGlobalChanged: true,
      },
    });
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain(hookScriptPath);
  });

  it("warns on doctor only when install_hooks requested Codex hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const requested = await runCli(
      [
        "--config",
        requestedConfigPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
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
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "codex",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        status: "ok",
      },
    });
  });

  it("warns when doctor finds stale generated global Codex hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    const doctor = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(doctor).toMatchObject({
      code: 1,
      output: {
        provider: "codex",
        status: "warn",
        installed: true,
        generatedGlobalCleanup: {
          changed: true,
          stale: ["PreToolUse"],
        },
      },
    });
  });
});

function codexEnv(root: string): Record<string, string> {
  return { CODEX_HOME: join(root, "codex-home") };
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
      'harness = "codex"',
      'layout = "agent-shell"',
      "",
      "[harness.codex]",
      'command = "codex"',
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

function generatedGlobalCodexConfig(hookScriptPath: string): string {
  return [
    "[[hooks.PreToolUse]]",
    'matcher = ".*"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(hookScriptPath)}`,
    "timeout = 30",
    'statusMessage = "Notify station"',
    "",
  ].join("\n");
}
