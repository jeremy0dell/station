import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerHookScriptRoutesByStationEnv } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  doctorCrushHooks,
  installCrushHooks,
  planCrushHooks,
  uninstallCrushHooks,
} from "../../src/hooks";

describe("Crush hook setup", () => {
  it("plans hook config and generated script without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");

    const plan = await planCrushHooks({
      crushConfigPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/usr/local/bin/stn-ingress",
    });

    expect(plan).toMatchObject({
      provider: "crush",
      configPath: crushConfigPath,
      hookScriptPath,
      changed: true,
      configChanged: true,
      scriptChanged: true,
      missing: ["PreToolUse"],
    });
    expect(plan.commands.PreToolUse).toBe(hookScriptPath);
    expect(plan.after).toContain('"PreToolUse"');
    await expect(readFile(crushConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("installs, merges .crush.json, writes a 0700 script, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");
    await writeFile(crushConfigPath, existingCrushConfig(), "utf8");

    const installed = await installCrushHooks({
      crushConfigPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
    });
    const second = await installCrushHooks({
      crushConfigPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
    });
    const config = JSON.parse(await readFile(crushConfigPath, "utf8"));
    const script = await readFile(hookScriptPath, "utf8");
    const scriptMode = (await stat(hookScriptPath)).mode & 0o777;

    expect(installed.backupPath).toBeDefined();
    expect(installed.backupPaths).toHaveLength(1);
    expect(second.changed).toBe(false);
    expect(config.note).toBe("preserved");
    expect(config.hooks.PreToolUse).toContainEqual({
      name: "existing",
      command: "echo existing",
      timeout: 5,
    });
    expect(config.hooks.PreToolUse).toContainEqual({
      name: "station",
      command: hookScriptPath,
      timeout: 30,
    });
    expect(config.hooks.PostToolUse).toEqual([{ command: "echo after", timeout: 5 }]);
    expect(providerHookScriptRoutesByStationEnv(script, "crush")).toBe(true);
    expect(script).toContain("SOCKET_ARG=(--socket /tmp/station/run/observer.sock)");
    expect(script).toContain("CONFIG_ARG=(--config /tmp/station/config.toml)");
    expect(script).toContain("STATE_DIR_ARG=(--state-dir /tmp/station/state)");
    expect(script).toContain("SPOOL_DIR_ARG=(--spool-dir /tmp/station/state/spool/hooks)");
    expect(script).toContain("--no-auto-start crush");
    expect(script).toContain(
      `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    );
    expect(script).toContain("crush > /dev/null");
    expect(scriptMode).toBe(0o700);
    await expect(
      doctorCrushHooks({
        crushConfigPath,
        hookScriptPath,
        stationConfigPath: "/tmp/station/config.toml",
        observerSocketPath: "/tmp/station/run/observer.sock",
        stateDir: "/tmp/station/state",
        hookSpoolDir: "/tmp/station/state/spool/hooks",
        autoStartFromHooks: false,
        enabled: true,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: true,
      configPath: crushConfigPath,
      hookScriptPath,
    });
  });

  it("generated script exits before hook invocation without ownership env", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");

    await installCrushHooks({
      crushConfigPath,
      hookScriptPath,
      hookBin: join(root, "missing-stn-ingress"),
    });

    for (const env of [
      {},
      { STATION_SESSION_ID: "ses_web_task" },
      { STATION_WORKTREE_ID: "wt_web_task" },
    ]) {
      const result = await runHookScript(hookScriptPath, "{ invalid json", {
        TMPDIR: root,
        ...env,
      });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  });

  it("generated script invokes stn-ingress with Crush stdin when ownership env is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");
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

    await installCrushHooks({
      crushConfigPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
    });

    const payload = JSON.stringify({ event: "PreToolUse", tool_name: "bash" });
    const result = await runHookScript(hookScriptPath, payload, {
      TMPDIR: root,
      STATION_SESSION_ID: "ses_web_task",
      STATION_WORKTREE_ID: "wt_web_task",
    });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml crush\n",
    );
    await expect(readFile(stdinLog, "utf8")).resolves.toBe(payload);
  });

  it("uninstalls generated hooks without removing unrelated commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");
    await writeFile(crushConfigPath, existingCrushConfig(), "utf8");
    await installCrushHooks({ crushConfigPath, hookScriptPath });

    const removed = await uninstallCrushHooks({ crushConfigPath, hookScriptPath });
    const config = JSON.parse(await readFile(crushConfigPath, "utf8"));

    expect(removed.installed).toBe(false);
    expect(removed.scriptRemoved).toBe(true);
    expect(config.hooks.PreToolUse).toEqual([
      {
        name: "existing",
        command: "echo existing",
        timeout: 5,
      },
    ]);
    expect(config.hooks.PostToolUse).toEqual([{ command: "echo after", timeout: 5 }]);
    await expect(access(hookScriptPath)).rejects.toThrow();
  });

  it("only warns for missing hooks when install_hooks requested them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, "state", "hooks", "station-crush-hook.sh");

    await expect(
      doctorCrushHooks({ crushConfigPath, hookScriptPath, enabled: false }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: false,
    });
    await expect(
      doctorCrushHooks({ crushConfigPath, hookScriptPath, enabled: true }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
  });

  it("maps invalid Crush JSON to a typed setup error", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-crush-hooks-"));
    const crushConfigPath = join(root, ".crush.json");
    await writeFile(crushConfigPath, "{ invalid json", "utf8");

    await expect(planCrushHooks({ crushConfigPath })).rejects.toMatchObject({
      tag: "CrushHookSetupError",
      code: "CRUSH_HOOK_INVALID_JSON",
      provider: "crush",
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

function existingCrushConfig(): string {
  return JSON.stringify(
    {
      note: "preserved",
      hooks: {
        PreToolUse: [{ name: "existing", command: "echo existing", timeout: 5 }],
        PostToolUse: [{ command: "echo after", timeout: 5 }],
      },
    },
    null,
    2,
  );
}
