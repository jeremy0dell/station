import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
    expect(plan.after).toContain('method: "observer.ingestProviderHookEvent"');
    expect(plan.after).toContain('provider: "opencode"');
    expect(plan.after).toContain("shouldSendOpenCodeEvent");
    expect(plan.after).not.toContain('"message.part.delta"');
    expect(plan.after).not.toContain('"message.part.updated"');
    expect(plan.after).toContain('"session.next.shell.started"');
    expect(plan.after).toContain('"session.next.tool.progress"');
    expect(plan.after).toContain('"session.next.tool.input.delta"');
    expect(plan.after).toContain("/tmp/station/run/observer.sock");
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
    expect(script).toContain("spoolHookEvent");
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

  it("synchronously spools completion events before async delivery settles", async () => {
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
      process.env.STATION_SESSION_ID = "ses_1";
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
      const pending = plugin.event({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "opencode_session_1",
          },
        },
      });

      const files = await readdir(spoolDir);
      expect(files).toHaveLength(1);
      const record = JSON.parse(await readFile(join(spoolDir, files[0] ?? ""), "utf8"));
      expect(record).toMatchObject({
        event: {
          provider: "opencode",
          kind: "harness",
          event: "session.idle",
          sessionId: "ses_1",
          payload: {
            event_type: "session.idle",
            opencode_session_id: "opencode_session_1",
          },
        },
      });
      await pending;
    } finally {
      process.env = previousEnv;
    }
  });

  it("removes pre-spooled completion events after successful delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-plugin-"));
    const pluginPath = join(root, "opencode", "plugins", "station-agent-state.js");
    const spoolDir = join(root, "spool");
    const socketPath = join(root, "observer.sock");
    await installOpenCodePlugin({
      pluginPath,
      observerSocketPath: socketPath,
      stateDir: join(root, "state"),
      hookSpoolDir: spoolDir,
    });
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { accepted: true },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const previousEnv = { ...process.env };
    try {
      process.env.STATION_HARNESS_PROVIDER = "opencode";
      process.env.STATION_WORKTREE_ID = "wt_1";
      process.env.STATION_SESSION_ID = "ses_1";
      process.env.STATION_HOOK_SPOOL_DIR = spoolDir;
      process.env.STATION_OBSERVER_SOCKET_PATH = socketPath;
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

      await expect(readdir(spoolDir)).resolves.toHaveLength(0);
    } finally {
      process.env = previousEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
