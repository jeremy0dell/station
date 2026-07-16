import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerHookScriptRoutesByStationEnv } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  doctorCodexHooks,
  installCodexHooks,
  planCodexHooks,
  uninstallCodexHooks,
} from "../../src/hooks";

describe("Codex hook setup", () => {
  it("plans hook config and generated script without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const plan = await planCodexHooks({
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/usr/local/bin/stn-ingress",
      env: { CODEX_HOME: codexHome },
    });

    expect(plan.changed).toBe(true);
    expect(plan.configPath).toBe(configPath);
    expect(plan.profileName).toBe("station");
    expect(plan.profileConfigPath).toBe(configPath);
    expect(plan.baseConfigPath).toBe(baseConfigPath);
    expect(plan.missing).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
    expect(plan.commands.PreToolUse).toBe(hookScriptPath);
    expect(plan.after).toContain("[[hooks.PreToolUse]]");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
    await expect(readFile(baseConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("installs into the station profile, cleans generated global entries, and preserves unrelated hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, existingCodexConfig(), "utf8");
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    const installed = await installCodexHooks({
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/tmp/checkout/bin/stn-ingress",
      env,
    });
    const second = await installCodexHooks({
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/tmp/checkout/bin/stn-ingress",
      env,
    });
    const config = await readFile(configPath, "utf8");
    const baseConfig = await readFile(baseConfigPath, "utf8");
    const script = await readFile(hookScriptPath, "utf8");
    const scriptMode = (await stat(hookScriptPath)).mode & 0o777;

    expect(installed.backupPath).toBeDefined();
    expect(installed.profileBackupPath).toBeDefined();
    expect(installed.baseBackupPath).toBeDefined();
    expect(installed.backupPaths).toHaveLength(2);
    expect(installed.generatedGlobalCleanup.stale).toEqual(["PreToolUse"]);
    expect(second.changed).toBe(false);
    expect(config).toContain("echo existing");
    expect(config).toContain(hookScriptPath);
    expect(baseConfig).toContain("echo existing");
    expect(baseConfig).not.toContain(hookScriptPath);
    expect(providerHookScriptRoutesByStationEnv(script, "codex")).toBe(true);
    expect(script).not.toContain("station-hook");
    expect(script).toContain("SOCKET_ARG=(--socket /tmp/station/run/observer.sock)");
    expect(script).toContain("CONFIG_ARG=(--config /tmp/station/config.toml)");
    expect(script).toContain("STATE_DIR_ARG=(--state-dir /tmp/station/state)");
    expect(script).toContain("SPOOL_DIR_ARG=(--spool-dir /tmp/station/state/spool/hooks)");
    // External sessions carry no station env; the script must deliver anyway
    // and leave scope decisions to the provider adapter.
    expect(script).not.toContain("STATION_SESSION_ID");
    expect(script).not.toContain("payload_file=");
    expect(script).toContain("codex > /dev/null");
    expect(scriptMode).toBe(0o700);
    await expect(
      doctorCodexHooks({
        hookScriptPath,
        stationConfigPath: "/tmp/station/config.toml",
        observerSocketPath: "/tmp/station/run/observer.sock",
        stateDir: "/tmp/station/state",
        hookSpoolDir: "/tmp/station/state/spool/hooks",
        enabled: true,
        env,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: true,
      profileConfigPath: configPath,
      baseConfigPath,
    });
  });

  it("generated script delivers to stn-ingress even without ownership env", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const hookBin = join(root, "stn-ingress");
    const argsLog = join(root, "hook.args");
    await writeFile(
      hookBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${shellQuote(argsLog)}`,
        "cat > /dev/null",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    await installCodexHooks({
      codexConfigPath: configPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
      env,
    });

    const payload = JSON.stringify({ hook_event_name: "PreToolUse" });
    const result = await runHookScript(hookScriptPath, payload, { TMPDIR: root });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml codex\n",
    );
  });

  it("generated script invokes stn-ingress with Codex stdin when ownership env is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const hookBin = join(root, "stn-ingress");
    const argsLog = join(root, "hook.args");
    const stdinLog = join(root, "hook.stdin");
    await writeFile(
      hookBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${shellQuote(argsLog)}`,
        `cat >> ${shellQuote(stdinLog)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    await installCodexHooks({
      codexConfigPath: configPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
      env,
    });

    const payload = JSON.stringify({ hook_event_name: "PreToolUse" });
    const result = await runHookScript(hookScriptPath, payload, {
      TMPDIR: root,
      STATION_SESSION_ID: "ses_web_task",
      STATION_WORKTREE_ID: "wt_web_task",
    });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml codex\n",
    );
    await expect(readFile(stdinLog, "utf8")).resolves.toBe(payload);
  });

  it("uninstalls generated hooks without removing unrelated commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, existingCodexConfig(), "utf8");
    await installCodexHooks({ hookScriptPath, env });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    const removed = await uninstallCodexHooks({ hookScriptPath, env });
    const config = await readFile(configPath, "utf8");
    const baseConfig = await readFile(baseConfigPath, "utf8");

    expect(removed.installed).toBe(false);
    expect(removed.scriptRemoved).toBe(true);
    expect(removed.generatedGlobalChanged).toBe(true);
    expect(config).toContain("echo existing");
    expect(config).not.toContain(hookScriptPath);
    expect(baseConfig).toContain("echo existing");
    expect(baseConfig).not.toContain(hookScriptPath);
    await expect(access(hookScriptPath)).rejects.toThrow();
  });

  it("only warns for missing hooks when install_hooks requested them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    await expect(
      doctorCodexHooks({ codexConfigPath: configPath, hookScriptPath, enabled: false, env }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: false,
    });
    await expect(
      doctorCodexHooks({ codexConfigPath: configPath, hookScriptPath, enabled: true, env }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
  });

  it("warns when generated global Codex hook entries remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };

    await installCodexHooks({ hookScriptPath, env });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    await expect(doctorCodexHooks({ hookScriptPath, enabled: true, env })).resolves.toMatchObject({
      status: "warn",
      installed: true,
      profileConfigPath: configPath,
      baseConfigPath,
      generatedGlobalCleanup: {
        changed: true,
        stale: ["PreToolUse"],
      },
    });
  });

  it("maps invalid Codex TOML to a typed setup error", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    await mkdir(join(root, "codex"), { recursive: true });
    await writeFile(configPath, "not = [valid");

    await expect(planCodexHooks({ codexConfigPath: configPath, env })).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_INVALID_TOML",
      provider: "codex",
    });
  });
});

async function runHookScript(
  scriptPath: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) {
    childEnv.PATH = process.env.PATH;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  const child = spawn(scriptPath, [], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    },
  );
  try {
    child.stdin.end(stdin);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      throw error;
    }
  }
  return completed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function codexEnv(root: string): Record<string, string> {
  return { CODEX_HOME: join(root, "codex-home") };
}

function existingCodexConfig(): string {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = ".*"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "echo existing"',
    "timeout = 10",
    "",
  ].join("\n");
}

function generatedGlobalCodexConfig(hookScriptPath: string): string {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = ".*"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "echo existing"',
    "timeout = 10",
    "",
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
