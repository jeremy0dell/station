import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  doctorOpenCodePlugin,
  installOpenCodePlugin,
  planOpenCodePlugin,
  resolveOpenCodeConfigDir,
  resolveOpenCodePluginPath,
  uninstallOpenCodePlugin,
} from "../../src/pluginInstall";

describe("OpenCode plugin setup", () => {
  it("plans the generated OpenCode plugin without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const opencodeConfigDir = join(root, "opencode");
    const pluginPath = join(opencodeConfigDir, "plugins", "station-agent-state.js");

    const plan = await planOpenCodePlugin({
      opencodeConfigDir,
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });

    expect(plan).toMatchObject({
      provider: "opencode",
      configDir: opencodeConfigDir,
      pluginPath,
      changed: true,
      installed: false,
    });
    expect(plan.after).toContain("station-opencode-observer-plugin:v1");
    expect(plan.after).toContain('import { spawn, spawnSync } from "node:child_process"');
    expect(plan.after).toContain('"stn-ingress"');
    expect(plan.after).toContain("STATION_INGRESS_BIN");
    expect(plan.after).toContain('args.push("opencode", eventType)');
    expect(plan.after).toContain("shouldSendOpenCodeEvent");
    expect(plan.after).not.toContain('"message.part.delta"');
    expect(plan.after).not.toContain('"message.part.updated"');
    expect(plan.after).toContain('"session.next.shell.started"');
    expect(plan.after).toContain('"session.next.tool.progress"');
    expect(plan.after).toContain('"session.next.tool.input.delta"');
    expect(plan.after).toContain("/tmp/station/run/observer.sock");
    expect(plan.after).not.toContain('from "node:net"');
    expect(plan.after).not.toContain('from "node:fs"');
    expect(plan.after).not.toContain("spoolHookEvent");
    await expect(readFile(pluginPath, "utf8")).rejects.toThrow();
  });

  it("resolves config dir from OPENCODE_CONFIG_DIR in process env", async () => {
    const previous = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = "/tmp/station/opencode-config";
    try {
      expect(resolveOpenCodeConfigDir()).toBe("/tmp/station/opencode-config");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previous;
      }
    }
  });

  it("installs, reports idempotence, and uninstalls only the generated plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");

    const installed = await installOpenCodePlugin({
      pluginPath,
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });
    const second = await installOpenCodePlugin({
      pluginPath,
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });
    const script = await readFile(pluginPath, "utf8");

    expect(installed).toMatchObject({
      installed: true,
      changed: true,
    });
    expect(second).toMatchObject({
      installed: true,
      changed: false,
    });
    expect(script).toContain("STATION_HARNESS_PROVIDER");
    expect(script).toContain("STATION_WORKTREE_ID");
    expect(script).not.toContain("spoolHookEvent");
    await expect(
      doctorOpenCodePlugin({
        pluginPath,
        observerSocketPath: "/tmp/station/run/observer.sock",
        stateDir: "/tmp/station/state",
        hookSpoolDir: "/tmp/station/state/spool/hooks",
        enabled: true,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: true,
    });

    const removed = await uninstallOpenCodePlugin({ pluginPath });
    expect(removed).toMatchObject({
      installed: false,
      changed: true,
      removed: true,
    });
    await expect(access(pluginPath)).rejects.toThrow();
  });

  it("does not remove unrelated user plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    await mkdir(join(root, "opencode", "plugins"), { recursive: true });
    await writeFile(pluginPath, "export const UserPlugin = async () => ({})\n", "utf8");

    const result = await uninstallOpenCodePlugin({ pluginPath });

    expect(result).toMatchObject({
      installed: false,
      changed: false,
      removed: false,
    });
    await expect(readFile(pluginPath, "utf8")).resolves.toContain("UserPlugin");
  });

  it("filters streaming message events before delivery or spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const spoolDir = join(root, "spool");
    await installOpenCodePlugin({
      pluginPath,
      observerSocketPath: join(root, "missing.sock"),
      stateDir: join(root, "state"),
      hookSpoolDir: spoolDir,
    });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_HOOK_SPOOL_DIR = spoolDir;
      process.env.STATION_OBSERVER_SOCKET_PATH = join(root, "missing.sock");
      const moduleUrl = pathToFileURL(pluginPath);
      moduleUrl.search = `v=${Date.now()}`;
      const pluginModule = (await import(moduleUrl.href)) as {
        StationObserverPlugin: (input: { directory: string; worktree: string }) => Promise<{
          event: (input: { event: unknown }) => Promise<void>;
        }>;
      };

      const plugin = await pluginModule.StationObserverPlugin({ directory: root, worktree: root });
      await plugin.event({
        event: {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_1",
            messageID: "msg_1",
            partID: "part_1",
          },
        },
      });

      await expect(readdir(spoolDir)).rejects.toThrow();
    } finally {
      process.env = previousEnv;
    }
  });

  it("delegates ordinary events to stn-ingress without awaiting child completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const recorder = await writeIngressRecorder(root);
    await installOpenCodePlugin({ pluginPath });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_SESSION_ID = "ses_1";
      process.env.STATION_INGRESS_BIN = recorder.ingressPath;
      process.env.STATION_OBSERVER_SOCKET_PATH = join(root, "observer.sock");
      process.env.STATION_OBSERVER_STATE_DIR = join(root, "state");
      process.env.STATION_HOOK_SPOOL_DIR = join(root, "spool");
      process.env.STATION_CONFIG_PATH = join(root, "config.toml");
      process.env.STATION_TEST_INGRESS_RELEASE = recorder.releasePath;
      const moduleUrl = pathToFileURL(pluginPath);
      moduleUrl.search = `v=${Date.now()}`;
      const pluginModule = (await import(moduleUrl.href)) as {
        StationObserverPlugin: (input: { directory: string; worktree: string }) => Promise<{
          event: (input: { event: unknown }) => Promise<void>;
        }>;
      };

      const plugin = await pluginModule.StationObserverPlugin({ directory: root, worktree: root });
      await plugin.event({
        event: {
          type: "session.created",
          properties: { sessionID: "opencode_session_1" },
        },
      });

      await waitForFile(recorder.startedPath);
      await expect(access(recorder.completedPath)).rejects.toThrow();
      expect(JSON.parse(await readFile(recorder.argsPath, "utf8"))).toEqual([
        "--socket",
        join(root, "observer.sock"),
        "--state-dir",
        join(root, "state"),
        "--spool-dir",
        join(root, "spool"),
        "--config",
        join(root, "config.toml"),
        "opencode",
        "session.created",
      ]);
      expect(JSON.parse(await readFile(recorder.stdinPath, "utf8"))).toMatchObject({
        event_type: "session.created",
        opencode_session_id: "opencode_session_1",
      });

      const ingressPid = Number(await readFile(recorder.pidPath, "utf8"));
      await waitForProcessExit(ingressPid);
      await expect(access(recorder.completedPath)).rejects.toThrow();
    } finally {
      process.env = previousEnv;
    }
  }, 8_000);

  it("fails soft when synchronous completion ingress cannot start without local spooling", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const spoolDir = join(root, "spool");
    await installOpenCodePlugin({ pluginPath, hookSpoolDir: spoolDir });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_SESSION_ID = "ses_1";
      process.env.STATION_INGRESS_BIN = join(root, "missing-stn-ingress");
      process.env.STATION_HOOK_SPOOL_DIR = spoolDir;
      const moduleUrl = pathToFileURL(pluginPath);
      moduleUrl.search = `v=${Date.now()}`;
      const pluginModule = (await import(moduleUrl.href)) as {
        StationObserverPlugin: (input: { directory: string; worktree: string }) => Promise<{
          event: (input: { event: unknown }) => Promise<void>;
        }>;
      };

      const plugin = await pluginModule.StationObserverPlugin({ directory: root, worktree: root });
      await expect(
        plugin.event({
          event: {
            type: "session.idle",
            properties: { sessionID: "opencode_session_1" },
          },
        }),
      ).resolves.toBeUndefined();
      await expect(access(spoolDir)).rejects.toThrow();
    } finally {
      process.env = previousEnv;
    }
  });

  it("bounds synchronous completion ingress when the child never exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const spoolDir = join(root, "spool");
    const recorder = await writeIngressRecorder(root);
    await installOpenCodePlugin({ pluginPath, hookSpoolDir: spoolDir });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_SESSION_ID = "ses_1";
      process.env.STATION_INGRESS_BIN = recorder.ingressPath;
      process.env.STATION_HOOK_SPOOL_DIR = spoolDir;
      process.env.STATION_TEST_INGRESS_RELEASE = recorder.releasePath;
      const moduleUrl = pathToFileURL(pluginPath);
      moduleUrl.search = `v=${Date.now()}`;
      const pluginModule = (await import(moduleUrl.href)) as {
        StationObserverPlugin: (input: { directory: string; worktree: string }) => Promise<{
          event: (input: { event: unknown }) => Promise<void>;
        }>;
      };

      const plugin = await pluginModule.StationObserverPlugin({ directory: root, worktree: root });
      const startedAt = Date.now();
      await expect(
        plugin.event({
          event: {
            type: "session.idle",
            properties: { sessionID: "opencode_session_1" },
          },
        }),
      ).resolves.toBeUndefined();

      expect(Date.now() - startedAt).toBeLessThan(7_000);
      await expect(access(recorder.startedPath)).resolves.toBeUndefined();
      await expect(access(recorder.completedPath)).rejects.toThrow();
      await expect(access(spoolDir)).rejects.toThrow();
    } finally {
      process.env = previousEnv;
    }
  }, 8_000);

  it("waits for stn-ingress completion for session.idle without plugin-local spooling", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const spoolDir = join(root, "spool");
    const recorder = await writeIngressRecorder(root);
    await installOpenCodePlugin({
      pluginPath,
      observerSocketPath: join(root, "fallback-observer.sock"),
      stateDir: join(root, "state"),
      hookSpoolDir: spoolDir,
    });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_SESSION_ID = "ses_1";
      process.env.STATION_INGRESS_BIN = recorder.ingressPath;
      process.env.STATION_HOOK_SPOOL_DIR = spoolDir;
      process.env.STATION_OBSERVER_SOCKET_PATH = join(root, "runtime-observer.sock");
      process.env.STATION_OBSERVER_STATE_DIR = join(root, "runtime-state");
      process.env.STATION_CONFIG_PATH = join(root, "runtime-config.toml");
      const moduleUrl = pathToFileURL(pluginPath);
      moduleUrl.search = `v=${Date.now()}`;
      const pluginModule = (await import(moduleUrl.href)) as {
        StationObserverPlugin: (input: { directory: string; worktree: string }) => Promise<{
          event: (input: { event: unknown }) => Promise<void>;
        }>;
      };

      const plugin = await pluginModule.StationObserverPlugin({ directory: root, worktree: root });
      await plugin.event({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "opencode_session_1",
          },
        },
      });

      await expect(access(recorder.completedPath)).resolves.toBeUndefined();
      await expect(access(spoolDir)).rejects.toThrow();
      expect(JSON.parse(await readFile(recorder.argsPath, "utf8"))).toEqual([
        "--socket",
        join(root, "runtime-observer.sock"),
        "--state-dir",
        join(root, "runtime-state"),
        "--spool-dir",
        spoolDir,
        "--config",
        join(root, "runtime-config.toml"),
        "opencode",
        "session.idle",
      ]);
      expect(JSON.parse(await readFile(recorder.stdinPath, "utf8"))).toMatchObject({
        event_type: "session.idle",
        opencode_session_id: "opencode_session_1",
      });
    } finally {
      process.env = previousEnv;
    }
  });

  it("resolves OpenCode config directory from environment", () => {
    expect(
      resolveOpenCodePluginPath({
        env: {
          OPENCODE_CONFIG_DIR: "/tmp/opencode-config",
        },
      }),
    ).toBe("/tmp/opencode-config/plugins/station-agent-state.js");
  });

  it("warns only when plugin installation was requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");

    await expect(doctorOpenCodePlugin({ pluginPath, enabled: false })).resolves.toMatchObject({
      status: "ok",
      installed: false,
    });
    await expect(doctorOpenCodePlugin({ pluginPath, enabled: true })).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
  });
});

async function writeIngressRecorder(root: string) {
  const ingressPath = join(root, "stn-ingress");
  const argsPath = join(root, "ingress-args.json");
  const stdinPath = join(root, "ingress-stdin.json");
  const startedPath = join(root, "ingress-started");
  const completedPath = join(root, "ingress-completed");
  const releasePath = join(root, "ingress-release");
  const pidPath = join(root, "ingress-pid");
  await writeFile(
    ingressPath,
    [
      "#!/usr/bin/env node",
      'const { existsSync, writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(stdinPath)}, input);`,
      `  writeFileSync(${JSON.stringify(startedPath)}, 'started');`,
      "  const release = process.env.STATION_TEST_INGRESS_RELEASE;",
      "  if (release === undefined) {",
      `    writeFileSync(${JSON.stringify(completedPath)}, 'completed');`,
      "    return;",
      "  }",
      "  const timer = setInterval(() => {",
      "    if (!existsSync(release)) return;",
      "    clearInterval(timer);",
      `    writeFileSync(${JSON.stringify(completedPath)}, 'completed');`,
      "  }, 5);",
      "});",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { ingressPath, argsPath, stdinPath, startedPath, completedPath, releasePath, pidPath };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out waiting for ingress process ${pid} to exit.`);
}
