import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  doctorCursorHooks,
  installCursorHooks,
  planCursorHooks,
  uninstallCursorHooks,
} from "../../src/hooks";

describe("Cursor hook setup", () => {
  it("plans hook config and generated script without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");

    const plan = await planCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/usr/local/bin/stn-ingress",
    });

    expect(plan).toMatchObject({
      provider: "cursor",
      hooksPath,
      hookScriptPath,
      changed: true,
      configChanged: true,
      scriptChanged: true,
      missing: [
        "sessionStart",
        "stop",
        "sessionEnd",
        "beforeShellExecution",
        "afterShellExecution",
        "preToolUse",
        "postToolUse",
        "postToolUseFailure",
      ],
    });
    expect(plan.commands.beforeShellExecution).toBe(hookScriptPath);
    expect(plan.after).toContain('"beforeShellExecution"');
    await expect(readFile(hooksPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("installs, merges hooks.json, writes a 0700 script, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    await mkdir(join(root, "cursor"), { recursive: true });
    await writeFile(hooksPath, existingCursorHooks(), "utf8");

    const installed = await installCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
    });
    const second = await installCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      autoStartFromHooks: false,
    });
    const config = JSON.parse(await readFile(hooksPath, "utf8"));
    const script = await readFile(hookScriptPath, "utf8");
    const scriptMode = (await stat(hookScriptPath)).mode & 0o777;

    expect(installed.backupPath).toBeDefined();
    expect(installed.backupPaths).toHaveLength(1);
    expect(second.changed).toBe(false);
    expect(config.note).toBe("preserved");
    expect(config.hooks.afterShellExecution).toContainEqual({
      command: "echo existing",
      timeout: 5,
    });
    expect(config.hooks.afterShellExecution).toContainEqual({
      command: hookScriptPath,
      timeout: 30,
    });
    expect(config.hooks.beforeShellExecution).toEqual([{ command: hookScriptPath, timeout: 30 }]);
    expect(script).toContain(
      `if [ -n "${shellParameter("STATION_OBSERVER_SOCKET_PATH:-")}" ]; then`,
    );
    expect(script).toContain('SOCKET_ARG=(--socket "$STATION_OBSERVER_SOCKET_PATH")');
    expect(script).toContain("SOCKET_ARG=(--socket /tmp/station/run/observer.sock)");
    expect(script).toContain('CONFIG_ARG=(--config "$STATION_CONFIG_PATH")');
    expect(script).toContain("CONFIG_ARG=(--config /tmp/station/config.toml)");
    expect(script).toContain(providerHookScriptCommand("stn-ingress", "cursor", "--no-auto-start"));
    expect(script).toContain(
      `if [ -z "\${STATION_SESSION_ID:-}" ] || [ -z "\${STATION_WORKTREE_ID:-}" ]; then`,
    );
    expect(script).toContain("cursor > /dev/null");
    expect(scriptMode).toBe(0o700);
    await expect(
      doctorCursorHooks({
        cursorHooksPath: hooksPath,
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
      hooksPath,
      hookScriptPath,
    });
  });

  it("doctor accepts a shared generated hook script that routes by Station env", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const sharedHookScriptPath = join(root, "default", "hooks", "station-cursor-hook.sh");
    const demoHookScriptPath = join(root, "demo", "hooks", "station-cursor-hook.sh");

    await installCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath: sharedHookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });

    await expect(
      doctorCursorHooks({
        cursorHooksPath: hooksPath,
        hookScriptPath: demoHookScriptPath,
        stationConfigPath: "/tmp/demo/config.toml",
        observerSocketPath: "/tmp/demo/run/observer.sock",
        stateDir: "/tmp/demo/state",
        hookSpoolDir: "/tmp/demo/state/spool/hooks",
        enabled: true,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: true,
      hookScriptPath: sharedHookScriptPath,
      commands: {
        sessionStart: sharedHookScriptPath,
        postToolUse: sharedHookScriptPath,
      },
    });
  });

  it("generated script exits before hook invocation without ownership env", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");

    await installCursorHooks({
      cursorHooksPath: hooksPath,
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

  it("generated script invokes stn-ingress with Cursor stdin when ownership env is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
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

    await installCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
    });

    const payload = JSON.stringify({ hook_event_name: "sessionStart" });
    const result = await runHookScript(hookScriptPath, payload, {
      TMPDIR: root,
      STATION_SESSION_ID: "ses_web_task",
      STATION_WORKTREE_ID: "wt_web_task",
    });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml cursor\n",
    );
    await expect(readFile(stdinLog, "utf8")).resolves.toBe(payload);
  });

  it("generated script routes through launched Station config env when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    const hookBin = join(root, "stn-ingress");
    const argsLog = join(root, "hook.args");
    await writeFile(
      hookBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${shellQuote(argsLog)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    await installCursorHooks({
      cursorHooksPath: hooksPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin,
    });

    const result = await runHookScript(hookScriptPath, '{"hook_event_name":"sessionStart"}', {
      TMPDIR: root,
      STATION_SESSION_ID: "ses_web_task",
      STATION_WORKTREE_ID: "wt_web_task",
      STATION_CONFIG_PATH: "/tmp/demo/config.toml",
      STATION_OBSERVER_SOCKET_PATH: "/tmp/demo/observer.sock",
    });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--socket /tmp/demo/observer.sock --config /tmp/demo/config.toml cursor\n",
    );
  });

  it("uninstalls generated hooks without removing unrelated commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    await mkdir(join(root, "cursor"), { recursive: true });
    await writeFile(hooksPath, existingCursorHooks(), "utf8");
    await installCursorHooks({ cursorHooksPath: hooksPath, hookScriptPath });

    const removed = await uninstallCursorHooks({ cursorHooksPath: hooksPath, hookScriptPath });
    const config = JSON.parse(await readFile(hooksPath, "utf8"));

    expect(removed.installed).toBe(false);
    expect(removed.scriptRemoved).toBe(true);
    expect(config.hooks.afterShellExecution).toEqual([{ command: "echo existing", timeout: 5 }]);
    expect(config.hooks.beforeShellExecution).toBeUndefined();
    await expect(access(hookScriptPath)).rejects.toThrow();
  });

  it("only warns for missing hooks when install_hooks requested them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");

    await expect(
      doctorCursorHooks({ cursorHooksPath: hooksPath, hookScriptPath, enabled: false }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: false,
    });
    await expect(
      doctorCursorHooks({ cursorHooksPath: hooksPath, hookScriptPath, enabled: true }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
  });

  it("maps invalid Cursor JSON to a typed setup error", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-hooks-"));
    const hooksPath = join(root, "cursor", "hooks.json");
    await mkdir(join(root, "cursor"), { recursive: true });
    await writeFile(hooksPath, "{ invalid json", "utf8");

    await expect(planCursorHooks({ cursorHooksPath: hooksPath })).rejects.toMatchObject({
      tag: "CursorHookSetupError",
      code: "CURSOR_HOOK_INVALID_JSON",
      provider: "cursor",
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

function providerHookScriptCommand(hookBin: string, provider: string, ...flags: string[]): string {
  return [
    hookBin,
    guardedArg("SOCKET_ARG"),
    guardedArg("STATE_DIR_ARG"),
    guardedArg("SPOOL_DIR_ARG"),
    guardedArg("CONFIG_ARG"),
    ...flags,
    provider,
  ].join(" ");
}

function guardedArg(name: string): string {
  return ["$", `{${name}[@]+"`, "$", `{${name}[@]}"}`].join("");
}

function shellParameter(name: string): string {
  return ["$", `{${name}}`].join("");
}

function existingCursorHooks(): string {
  return JSON.stringify(
    {
      version: 1,
      note: "preserved",
      hooks: {
        afterShellExecution: [{ command: "echo existing", timeout: 5 }],
      },
    },
    null,
    2,
  );
}
