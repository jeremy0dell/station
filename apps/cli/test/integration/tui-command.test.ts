import { EventEmitter } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@station/cli";
import {
  type ObserverProcessDeps,
  resolvePopupTmuxCommand,
  runTuiCommand,
  type TuiCommandDeps,
} from "@station/cli/internal";
import type { TuiConfig } from "@station/config";
import { TUI_RENDERER_CONTROL_PROTOCOL_VERSION } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { resolveStationWorkspaceDir } from "../../src/stationWorkspace.js";

const now = "2026-05-20T12:00:00.000Z";
const tuiConfig: TuiConfig = {
  widgets: [
    {
      type: "time",
      timeFormat: "12h",
    },
    {
      type: "weather",
      city: "New York, NY",
      label: "NYC",
      temperatureUnit: "fahrenheit",
      refreshIntervalMinutes: 15,
    },
  ],
};

function emptySnapshot(reason: string) {
  return {
    schemaVersion: "0.8.0",
    reason,
    reconciledAt: now,
    snapshot: {
      schemaVersion: "0.8.0",
      generatedAt: now,
      observer: { pid: 1234, startedAt: now, version: "0.7.0", healthy: true },
      providerHealth: {},
      projects: [],
      rows: [],
      sessions: [],
      counts: {
        projects: 0,
        sessions: 0,
        worktrees: 0,
        agents: 0,
        working: 0,
        idle: 0,
        attention: 0,
        unknown: 0,
      },
      alerts: [],
    },
  };
}

// A running observer whose health check passes once spawned. `reconcile`
// records its reason (or hangs, to model the non-blocking startup reconcile).
type SpawnObserverInput = Parameters<NonNullable<ObserverProcessDeps["spawnObserver"]>>[0];

function runningObserverDeps(
  options: { reconciles?: string[]; hangReconcile?: boolean; spawns?: SpawnObserverInput[] } = {},
) {
  let running = false;
  return {
    buildVersion: "0.0.0",
    spawnObserver: async (input: SpawnObserverInput) => {
      options.spawns?.push(input);
      running = true;
      return { pid: 1234, unref: () => undefined };
    },
    clientFactory: () =>
      ({
        health: async () => {
          if (!running) throw new Error("stopped");
          return {
            schemaVersion: "0.8.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: "0.7.0",
          };
        },
        reconcile: (reason: string) => {
          options.reconciles?.push(reason);
          if (options.hangReconcile === true) {
            return new Promise(() => undefined);
          }
          return Promise.resolve(emptySnapshot(reason));
        },
      }) as never,
    sleep: async () => undefined,
  };
}

describe("CLI tui command", () => {
  it("prefers the configured popup command over the environment and default", () => {
    expect(resolvePopupTmuxCommand("config-tmux", { STATION_TMUX_BIN: "env-tmux" })).toBe(
      "config-tmux",
    );
    expect(resolvePopupTmuxCommand(undefined, { STATION_TMUX_BIN: "env-tmux" })).toBe("env-tmux");
    expect(resolvePopupTmuxCommand(undefined, {})).toBe("tmux");
  });
  it("launches the native first-run TUI without writing an implicit config", async () => {
    const fixture = await createTempState();
    const envs: Array<Record<string, string>> = [];
    const spawns: SpawnObserverInput[] = [];

    const result = await withIsolatedHome(fixture.root, () =>
      runCli([], {
        env: {},
        observerDeps: runningObserverDeps({ spawns }),
        tuiDeps: {
          spawnRenderer: async ({ env }) => {
            envs.push(env);
            return { status: "exited", code: 0 };
          },
        },
      }),
    );

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(spawns).toEqual([
      {
        paths: expect.objectContaining({
          stateDir: join(fixture.root, ".local/state/station"),
          socketPath: join(fixture.root, ".local/state/station/run/observer.sock"),
        }),
      },
    ]);
    expect(envs).toEqual([
      {
        STATION_OBSERVER_SOCKET_PATH: join(fixture.root, ".local/state/station/run/observer.sock"),
      },
    ]);
    await expect(access(join(fixture.root, ".config/station/config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps explicit missing and malformed implicit configs as hard errors", async () => {
    const fixture = await createTempState();
    const explicitPath = join(fixture.root, "missing.toml");
    const observerDeps: ObserverProcessDeps = {
      spawnObserver: async () => {
        throw new Error("observer should not start for config errors");
      },
    };
    const tuiDeps = {
      spawnRenderer: async () => {
        throw new Error("renderer should not start for config errors");
      },
    };

    await expect(
      runCli(["--config", explicitPath, "tui"], { observerDeps, tuiDeps }),
    ).rejects.toMatchObject({ code: "CONFIG_FILE_NOT_FOUND", configPath: explicitPath });

    const implicitPath = join(fixture.root, ".config/station/config.toml");
    await mkdir(join(fixture.root, ".config/station"), { recursive: true });
    await writeFile(implicitPath, "not = [valid toml", "utf8");
    await expect(
      withIsolatedHome(fixture.root, () => runCli([], { env: {}, observerDeps, tuiDeps })),
    ).rejects.toMatchObject({ code: "CONFIG_TOML_PARSE_FAILED", configPath: implicitPath });
  });

  it("starts or connects the observer and hands its socket to the renderer", async () => {
    const fixture = await createTempState();
    fixture.config.tui = tuiConfig;
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];
    const reconciles: string[] = [];

    const result = await runCli(["--config", configPath, "tui"], {
      observerDeps: runningObserverDeps({ reconciles }),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toEqual([{ STATION_OBSERVER_SOCKET_PATH: fixture.socketPath }]);
    // The startup reconcile is deferred and never awaited: not yet run when the
    // renderer resolves, then fires as "tui-startup".
    expect(reconciles).toEqual([]);
    await vi.waitFor(() => expect(reconciles).toEqual(["tui-startup"]));
  });

  it("reports slow observer startup before opening the native renderer", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let markSpawned = () => undefined;
    let releaseHealth = () => undefined;
    const observerSpawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const healthReady = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers();

    try {
      const resultPromise = runTuiCommand(
        [],
        { config: fixture.config },
        {
          observer: {
            spawnObserver: async () => {
              spawned = true;
              markSpawned();
              return { pid: 1234, unref: () => undefined };
            },
            clientFactory: () =>
              ({
                health: async () => {
                  if (!spawned) throw new Error("stopped");
                  await healthReady;
                  return {
                    schemaVersion: "0.8.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: "0.7.0",
                  };
                },
                reconcile: async () => emptySnapshot("tui-startup"),
              }) as never,
          },
          spawnRenderer,
        },
      );

      await observerSpawned;
      await vi.advanceTimersByTimeAsync(1_499);
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(spawnRenderer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(1, "Starting STATION observer…\n");

      await vi.advanceTimersByTimeAsync(3_499);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(spawnRenderer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(
        2,
        `Still waiting for STATION observer; boot log: ${join(
          fixture.stateDir,
          "logs/observer-boot.log",
        )}\n`,
      );
      expect(spawnRenderer).not.toHaveBeenCalled();

      releaseHealth();
      await expect(resultPromise).resolves.toEqual({ status: "exited", code: 0 });
      expect(spawnRenderer).toHaveBeenCalledOnce();
    } finally {
      releaseHealth();
      vi.clearAllTimers();
      vi.useRealTimers();
      stderrWrite.mockRestore();
    }
  });

  it("keeps warm observer attachment silent", async () => {
    const fixture = await createTempState();
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(
        runTuiCommand(
          [],
          { config: fixture.config },
          {
            observer: {
              spawnObserver: async () => {
                throw new Error("observer should not spawn for a warm attachment");
              },
              clientFactory: () =>
                ({
                  health: async () => ({
                    schemaVersion: "0.8.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: "0.7.0",
                  }),
                  reconcile: async () => emptySnapshot("tui-startup"),
                }) as never,
            },
            spawnRenderer,
          },
        ),
      ).resolves.toEqual({ status: "exited", code: 0 });
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(spawnRenderer).toHaveBeenCalledOnce();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("defaults bare station to the fullscreen renderer outside tmux", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];

    const result = await runCli(["--config", configPath], {
      env: {},
      observerDeps: runningObserverDeps(),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toEqual([{ STATION_OBSERVER_SOCKET_PATH: fixture.socketPath }]);
  });

  it("signals popup mode to the renderer via env", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];

    const result = await runCli(["--config", configPath, "tui", "--popup"], {
      observerDeps: runningObserverDeps(),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toEqual([
      {
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
        STATION_TUI_POPUP: "1",
      },
    ]);
  });

  it("launches the native station entry on bare, the dashboard entry in popup and mock", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const entries: string[] = [];
    const captureEntry = async ({ entry }: { entry: string }) => {
      entries.push(entry);
      return { status: "exited" as const, code: 0 };
    };

    // Bare (no $TMUX) → the native Station workspace.
    await runCli(["--config", configPath], {
      env: {},
      observerDeps: runningObserverDeps(),
      tuiDeps: { spawnRenderer: captureEntry },
    });
    // Explicit --popup (the in-tmux path) → the read-only dashboard.
    await runCli(["--config", configPath, "tui", "--popup"], {
      observerDeps: runningObserverDeps(),
      tuiDeps: { spawnRenderer: captureEntry },
    });
    // --dev-fake-dashboard previews the dashboard, never the native app.
    await runTuiCommand(
      ["--dev-fake-dashboard"],
      { config: fixture.config },
      {
        observer: {
          spawnObserver: async () => {
            throw new Error("observer should not start for fake dashboard mode");
          },
          clientFactory: () =>
            ({
              reconcile: async () => {
                throw new Error("startup reconcile should not run for fake dashboard mode");
              },
            }) as never,
        },
        spawnRenderer: captureEntry,
      },
    );

    expect(entries).toEqual(["station", "dashboard", "dashboard"]);
  });

  it("uses compiled self-exec and skips the source workspace installation preflight", async () => {
    const fixture = await createTempState();
    const stationUiInstalled = vi.fn(async () => false);
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child as never;
    });
    const previousOverride = process.env.STATION_DASHBOARD_COMMAND;
    delete process.env.STATION_DASHBOARD_COMMAND;

    try {
      await expect(
        runTuiCommand(
          ["--dev-fake-dashboard"],
          { config: fixture.config },
          {
            selfExecRuntime: { compiled: true, execPath: "/opt/station/stn" },
            stationUiInstalled,
            spawnProcess: spawnProcess as never,
          },
        ),
      ).resolves.toEqual({ status: "exited", code: 0 });
    } finally {
      if (previousOverride === undefined) delete process.env.STATION_DASHBOARD_COMMAND;
      else process.env.STATION_DASHBOARD_COMMAND = previousOverride;
    }

    expect(stationUiInstalled).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/station/stn",
      ["__dashboard"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          STATION_SOURCE: "mock",
          STATION_QUIET_PRELAUNCH: "1",
        }),
      }),
    );
  });

  it("preserves the source Bun renderer command, environment, and inherited stdio", async () => {
    const fixture = await createTempState();
    const stationUiInstalled = vi.fn(async () => true);
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child as never;
    });
    const previousOverride = process.env.STATION_DASHBOARD_COMMAND;
    delete process.env.STATION_DASHBOARD_COMMAND;

    try {
      await expect(
        runTuiCommand(
          ["--dev-fake-dashboard"],
          { config: fixture.config },
          {
            selfExecRuntime: { compiled: false, execPath: "/unused/stn" },
            stationUiInstalled,
            spawnProcess: spawnProcess as never,
          },
        ),
      ).resolves.toEqual({ status: "exited", code: 0 });
    } finally {
      if (previousOverride === undefined) delete process.env.STATION_DASHBOARD_COMMAND;
      else process.env.STATION_DASHBOARD_COMMAND = previousOverride;
    }

    expect(stationUiInstalled).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      "bun",
      ["run", "--silent", "--cwd", resolveStationWorkspaceDir(), "dashboard"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          STATION_SOURCE: "mock",
          STATION_QUIET_PRELAUNCH: "1",
        }),
      }),
    );
  });

  it("keeps the source installation preflight ahead of renderer spawn", async () => {
    const fixture = await createTempState();
    const spawnProcess = vi.fn();
    const previousOverride = process.env.STATION_DASHBOARD_COMMAND;
    delete process.env.STATION_DASHBOARD_COMMAND;

    try {
      await expect(
        runTuiCommand(
          ["--dev-fake-dashboard"],
          { config: fixture.config },
          {
            selfExecRuntime: { compiled: false, execPath: "/unused/stn" },
            stationUiInstalled: async () => false,
            spawnProcess: spawnProcess as never,
          },
        ),
      ).resolves.toEqual({ status: "exited", code: 1 });
    } finally {
      if (previousOverride === undefined) delete process.env.STATION_DASHBOARD_COMMAND;
      else process.env.STATION_DASHBOARD_COMMAND = previousOverride;
    }

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("preserves the explicit dashboard command shell override", async () => {
    const fixture = await createTempState();
    const stationUiInstalled = vi.fn(async () => false);
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child as never;
    });
    const previousOverride = process.env.STATION_DASHBOARD_COMMAND;
    process.env.STATION_DASHBOARD_COMMAND = "custom-dashboard --flag";

    try {
      await expect(
        runTuiCommand(
          ["--dev-fake-dashboard"],
          { config: fixture.config },
          { stationUiInstalled, spawnProcess: spawnProcess as never },
        ),
      ).resolves.toEqual({ status: "exited", code: 0 });
    } finally {
      if (previousOverride === undefined) delete process.env.STATION_DASHBOARD_COMMAND;
      else process.env.STATION_DASHBOARD_COMMAND = previousOverride;
    }

    expect(stationUiInstalled).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      "custom-dashboard --flag",
      expect.objectContaining({
        shell: true,
        stdio: "inherit",
        env: expect.objectContaining({
          STATION_SOURCE: "mock",
          STATION_QUIET_PRELAUNCH: "1",
        }),
      }),
    );
  });

  it("accepts --popup --persistent without exposing renderer-owned tmux state", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];

    const result = await runCli(["--config", configPath, "tui", "--popup", "--persistent"], {
      observerDeps: runningObserverDeps(),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toEqual([
      {
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
        STATION_TUI_PERSISTENT: "1",
        STATION_TUI_POPUP: "1",
      },
    ]);
  });

  it("opens an IPC channel only for the persistent compiled popup renderer", async () => {
    const persistent = await startPersistentRenderer();

    try {
      expect(persistent.spawnProcess).toHaveBeenCalledWith(
        "/opt/station/stn",
        ["__dashboard"],
        expect.objectContaining({
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        }),
      );
    } finally {
      await persistent.finish();
    }
  });

  it("preserves the persistent source Bun renderer command with IPC", async () => {
    const persistent = await startPersistentRenderer({ source: true });
    const workspaceDir = resolveStationWorkspaceDir();

    try {
      expect(persistent.spawnProcess).toHaveBeenNthCalledWith(
        1,
        "bun",
        ["run", "--silent", "--cwd", workspaceDir, "link:station"],
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(persistent.spawnProcess).toHaveBeenNthCalledWith(
        2,
        "bun",
        ["src/dashboardRenderer/main.tsx"],
        expect.objectContaining({
          cwd: workspaceDir,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        }),
      );
    } finally {
      await persistent.finish();
    }
  });

  it("does not spawn the persistent source renderer when station linking fails", async () => {
    const persistent = await startPersistentRenderer({ source: true, linkExitCode: 23 });

    expect(persistent.spawnProcess).toHaveBeenCalledOnce();
    expect(persistent.spawnProcess).toHaveBeenCalledWith(
      "bun",
      ["run", "--silent", "--cwd", resolveStationWorkspaceDir(), "link:station"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    await persistent.finish();
  });

  it("preserves the persistent dashboard shell override with IPC", async () => {
    const previousOverride = process.env.STATION_DASHBOARD_COMMAND;
    process.env.STATION_DASHBOARD_COMMAND = "custom-dashboard --flag";
    const persistent = await startPersistentRenderer();

    try {
      expect(persistent.spawnProcess).toHaveBeenCalledWith(
        "custom-dashboard --flag",
        expect.objectContaining({
          shell: true,
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        }),
      );
    } finally {
      await persistent.finish();
      if (previousOverride === undefined) delete process.env.STATION_DASHBOARD_COMMAND;
      else process.env.STATION_DASHBOARD_COMMAND = previousOverride;
    }
  });

  it("routes correlated popup requests and resolves the current focus origin each time", async () => {
    const dismissPopup = vi.fn(async () => ({ dismissed: true }));
    const resolveFocusTarget = vi
      .fn()
      .mockResolvedValueOnce(focusTarget("client-a"))
      .mockResolvedValueOnce(focusTarget("client-b"));
    const persistent = await startPersistentRenderer({
      popupControl: { dismissPopup, resolveFocusTarget },
    });

    try {
      persistent.child.emit("message", controlRequest("resolve-1", "resolve-focus-target"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(1));
      expect(persistent.child.sent[0]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "resolve-1",
        type: "focus-target",
        origin: { provider: "tmux", clientId: "client-a" },
      });

      persistent.child.emit("message", controlRequest("dismiss-1", "dismiss"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(2));
      expect(persistent.child.sent[1]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "dismiss-1",
        type: "dismissed",
      });

      persistent.child.emit("message", controlRequest("resolve-2", "resolve-focus-target"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(3));
      expect(persistent.child.sent[2]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "resolve-2",
        type: "focus-target",
        origin: { provider: "tmux", clientId: "client-b" },
      });
      expect(resolveFocusTarget).toHaveBeenCalledTimes(2);
      expect(dismissPopup).toHaveBeenCalledOnce();
    } finally {
      await persistent.finish();
    }
  });

  it("does not let a late focus completion dismiss a newer popup target", async () => {
    const dismissA = vi.fn(async () => ({ dismissed: true }));
    const dismissB = vi.fn(async () => ({ dismissed: true }));
    const resolveFocusTarget = vi
      .fn()
      .mockResolvedValueOnce(focusTarget("client-a", dismissA))
      .mockResolvedValueOnce(focusTarget("client-b", dismissB));
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup: async () => ({ dismissed: true }),
        resolveFocusTarget,
      },
    });

    try {
      persistent.child.emit("message", controlRequest("focus-a", "resolve-focus-target"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(1));
      persistent.child.emit("message", controlRequest("focus-b", "resolve-focus-target"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(2));

      persistent.child.emit("message", {
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "dismiss-a",
        type: "dismiss-focus-target",
        focusRequestId: "focus-a",
      });
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(3));
      expect(persistent.child.sent[2]).toMatchObject({
        requestId: "dismiss-a",
        type: "error",
        error: { code: "TUI_POPUP_FOCUS_TARGET_STALE" },
      });
      expect(dismissA).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();

      persistent.child.emit("message", {
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "dismiss-b",
        type: "dismiss-focus-target",
        focusRequestId: "focus-b",
      });
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(4));
      expect(persistent.child.sent[3]).toMatchObject({
        requestId: "dismiss-b",
        type: "dismissed",
      });
      expect(dismissB).toHaveBeenCalledOnce();
    } finally {
      await persistent.finish();
    }
  });

  it("coalesces duplicate manual dismiss effects", async () => {
    let finishDismiss = (_result: { dismissed: boolean }) => undefined;
    const dismissal = new Promise<{ dismissed: boolean }>((resolve) => {
      finishDismiss = resolve;
    });
    const dismissPopup = vi.fn(() => dismissal);
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup,
        resolveFocusTarget: async () => focusTarget("client-a"),
      },
    });

    try {
      persistent.child.emit("message", controlRequest("dismiss-1", "dismiss"));
      persistent.child.emit("message", controlRequest("dismiss-2", "dismiss"));
      await vi.waitFor(() => expect(dismissPopup).toHaveBeenCalledOnce());
      finishDismiss({ dismissed: true });
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(2));
      expect(persistent.child.sent).toEqual([
        expect.objectContaining({ requestId: "dismiss-1", type: "dismissed" }),
        expect.objectContaining({ requestId: "dismiss-2", type: "dismissed" }),
      ]);
    } finally {
      await persistent.finish();
    }
  });

  it("returns correlated SafeErrors without closing a valid control channel", async () => {
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup: async () => {
          throw new Error("provider dismissal failed");
        },
        resolveFocusTarget: async () => {
          throw {
            tag: "TmuxProviderError",
            code: "TMUX_CLIENT_LOOKUP_FAILED",
            message: "The active tmux client could not be read.",
          };
        },
      },
    });

    try {
      persistent.child.emit("message", controlRequest("dismiss-failed", "dismiss"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(1));
      expect(persistent.child.sent[0]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "dismiss-failed",
        type: "error",
        error: {
          tag: "TuiRendererControlError",
          code: "TUI_POPUP_DISMISS_FAILED",
          message: "The popup could not be dismissed.",
        },
      });
      expect(persistent.child.connected).toBe(true);

      persistent.child.emit("message", controlRequest("resolve-failed", "resolve-focus-target"));
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(2));
      expect(persistent.child.sent[1]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "resolve-failed",
        type: "error",
        error: {
          tag: "TmuxProviderError",
          code: "TMUX_CLIENT_LOOKUP_FAILED",
          message: "The active tmux client could not be read.",
        },
      });
      expect(persistent.child.connected).toBe(true);
    } finally {
      await persistent.finish();
    }
  });

  it("disconnects after a renderer response send failure and ignores later requests", async () => {
    const dismissPopup = vi.fn(async () => ({ dismissed: true }));
    const resolveFocusTarget = vi.fn(async () => focusTarget("client-a"));
    const persistent = await startPersistentRenderer({
      popupControl: { dismissPopup, resolveFocusTarget },
      sendError: new Error("ipc write failed"),
    });

    try {
      persistent.child.emit("message", controlRequest("dismiss-before-error", "dismiss"));
      await vi.waitFor(() => expect(persistent.child.connected).toBe(false));
      expect(dismissPopup).toHaveBeenCalledOnce();
      expect(persistent.child.sent).toHaveLength(1);

      persistent.child.emit(
        "message",
        controlRequest("ignored-after-error", "resolve-focus-target"),
      );
      await Promise.resolve();
      expect(resolveFocusTarget).not.toHaveBeenCalled();
      expect(persistent.child.sent).toHaveLength(1);
    } finally {
      await persistent.finish();
    }
  });

  it("fails closed before acting on malformed renderer control frames", async () => {
    const dismissPopup = vi.fn(async () => ({ dismissed: true }));
    const resolveFocusTarget = vi.fn(async () => focusTarget("client-a"));
    const persistent = await startPersistentRenderer({
      popupControl: { dismissPopup, resolveFocusTarget },
    });

    try {
      persistent.child.emit("message", {
        ...controlRequest("unsafe", "dismiss"),
        command: "display-popup -C",
      });
      await vi.waitFor(() => expect(persistent.child.connected).toBe(false));
      expect(persistent.child.sent).toEqual([]);
      expect(dismissPopup).not.toHaveBeenCalled();
      expect(resolveFocusTarget).not.toHaveBeenCalled();
    } finally {
      await persistent.finish();
    }
  });

  it("closes on duplicate in-flight correlation ids and ignores late adapter completion", async () => {
    let completeResolution = (_target: ReturnType<typeof focusTarget>) => undefined;
    const resolution = new Promise<ReturnType<typeof focusTarget>>((resolve) => {
      completeResolution = resolve;
    });
    const resolveFocusTarget = vi.fn(() => resolution);
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup: async () => ({ dismissed: true }),
        resolveFocusTarget,
      },
    });

    try {
      const request = controlRequest("duplicate", "resolve-focus-target");
      persistent.child.emit("message", request);
      persistent.child.emit("message", request);
      await vi.waitFor(() => expect(persistent.child.connected).toBe(false));
      completeResolution(focusTarget("too-late"));
      await Promise.resolve();
      expect(resolveFocusTarget).toHaveBeenCalledOnce();
      expect(persistent.child.sent).toEqual([]);
    } finally {
      await persistent.finish();
    }
  });

  it("cleans up control listeners and ignores late adapter completion on child exit or disconnect", async () => {
    for (const childEvent of ["exit", "disconnect"] as const) {
      let completeResolution = (_target: ReturnType<typeof focusTarget>) => undefined;
      const resolution = new Promise<ReturnType<typeof focusTarget>>((resolve) => {
        completeResolution = resolve;
      });
      const persistent = await startPersistentRenderer({
        popupControl: {
          dismissPopup: async () => ({ dismissed: true }),
          resolveFocusTarget: () => resolution,
        },
      });

      persistent.child.emit("message", controlRequest(childEvent, "resolve-focus-target"));
      if (childEvent === "exit") {
        await persistent.finish();
      } else {
        persistent.child.disconnect();
      }
      completeResolution(focusTarget("too-late"));
      await Promise.resolve();

      expect(persistent.child.listenerCount("message")).toBe(0);
      expect(persistent.child.listenerCount("disconnect")).toBe(0);
      expect(persistent.child.sent).toEqual([]);
      if (childEvent === "disconnect") await persistent.finish();
    }
  });

  it("does not block popup renderer startup on observer reconcile", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];
    const reconciles: string[] = [];

    const result = await expectWithin(
      runCli(["--config", configPath, "tui", "--popup"], {
        observerDeps: runningObserverDeps({ reconciles, hangReconcile: true }),
        tuiDeps: {
          spawnRenderer: async ({ env }) => {
            envs.push(env);
            return { status: "exited", code: 0 };
          },
        },
      }),
      100,
    );

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toHaveLength(1);
    expect(reconciles).toEqual([]);
  });

  it("does not block native renderer startup on observer reconcile", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const envs: Array<Record<string, string>> = [];
    const reconciles: string[] = [];

    const result = await expectWithin(
      runCli(["--config", configPath, "tui"], {
        observerDeps: runningObserverDeps({ reconciles, hangReconcile: true }),
        tuiDeps: {
          spawnRenderer: async ({ env }) => {
            envs.push(env);
            return { status: "exited", code: 0 };
          },
        },
      }),
      100,
    );

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toHaveLength(1);
    expect(reconciles).toEqual([]);
  });

  it("does not open the renderer when the observer exits during startup", async () => {
    const fixture = await createTempState();
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));
    const result = await runTuiCommand(
      [],
      { config: fixture.config },
      {
        observer: {
          spawnObserver: async () => ({
            pid: 1234,
            unref: () => undefined,
            exited: Promise.resolve({ type: "exit" as const, code: 1, signal: null }),
          }),
          clientFactory: () =>
            ({
              health: async () => {
                throw new Error("still down");
              },
            }) as never,
        },
        spawnRenderer,
      },
    );

    expect(result).toMatchObject({
      status: "unavailable",
      code: 1,
      observer: { error: { code: "OBSERVER_EXITED_ON_START" } },
    });
    expect(spawnRenderer).not.toHaveBeenCalled();
  });

  it("runs the mock dashboard without observer startup or startup reconcile", async () => {
    const fixture = await createTempState();
    fixture.config.tui = tuiConfig;
    const envs: Array<Record<string, string>> = [];

    const result = await runTuiCommand(
      ["--dev-fake-dashboard", "--fake-projects", "3", "--fake-worktrees-per-project", "5"],
      { config: fixture.config },
      {
        observer: {
          spawnObserver: async () => {
            throw new Error("observer should not start for fake dashboard mode");
          },
          clientFactory: () =>
            ({
              reconcile: async () => {
                throw new Error("startup reconcile should not run for fake dashboard mode");
              },
            }) as never,
        },
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    );

    expect(result).toEqual({ status: "exited", code: 0 });
    expect(envs).toEqual([{ STATION_SOURCE: "mock" }]);
  });

  it("continues with defaults when widget config is invalid", async () => {
    const fixture = await createTempState();
    const configPath = `${fixture.root}/invalid-widget-config.toml`;
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[defaults]",
        'worktree_provider = "fake-worktree"',
        'terminal = "fake-terminal"',
        'harness = "fake-harness"',
        'layout = "agent-shell"',
        "",
        "[observer]",
        `socket_path = ${JSON.stringify(fixture.socketPath)}`,
        `state_dir = ${JSON.stringify(fixture.stateDir)}`,
        "",
        "[[tui.widgets]]",
        'type = "weather"',
        "",
      ].join("\n"),
      "utf8",
    );
    const envs: Array<Record<string, string>> = [];

    const result = await runCli(["--config", configPath, "tui"], {
      observerDeps: runningObserverDeps(),
      tuiDeps: {
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    });

    expect(result).toEqual({ code: 0, output: { status: "exited", code: 0 } });
    expect(envs).toEqual([{ STATION_OBSERVER_SOCKET_PATH: fixture.socketPath }]);
  });

  it("rejects invalid fake dashboard count flags before observer startup", async () => {
    const fixture = await createTempState();

    await expect(
      runTuiCommand(
        ["--dev-fake-dashboard", "--fake-projects", "0"],
        { config: fixture.config },
        {
          observer: {
            spawnObserver: async () => {
              throw new Error("observer should not start for invalid fake dashboard input");
            },
          },
        },
      ),
    ).rejects.toThrow("--fake-projects must be a positive integer.");

    await expect(
      runTuiCommand(
        ["--dev-fake-dashboard", "--fake-worktrees-per-project"],
        { config: fixture.config },
        {
          observer: {
            spawnObserver: async () => {
              throw new Error("observer should not start for invalid fake dashboard input");
            },
          },
        },
      ),
    ).rejects.toThrow("--fake-worktrees-per-project requires a value.");

    await expect(
      runTuiCommand(
        ["--fake-projects", "3"],
        { config: fixture.config },
        {
          observer: {
            spawnObserver: async () => {
              throw new Error("observer should not start for invalid fake dashboard input");
            },
          },
        },
      ),
    ).rejects.toThrow("--fake-projects requires --dev-fake-dashboard.");
  });

  it("rejects invalid TUI timeout values before observer startup", async () => {
    const fixture = await createTempState();

    await expect(
      runTuiCommand(
        ["--timeout-ms", "-1"],
        { config: fixture.config },
        {
          observer: {
            spawnObserver: async () => {
              throw new Error("observer should not start for invalid timeout input");
            },
          },
        },
      ),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
  });
});

async function expectWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function withIsolatedHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.HOME = home;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  }
}

class FakeRendererChild extends EventEmitter {
  connected = true;
  readonly sent: unknown[] = [];

  constructor(private readonly sendError: Error | null = null) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(this.sendError);
    return this.sendError === null;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnect");
  }
}

async function startPersistentRenderer(
  options: {
    linkExitCode?: number;
    popupControl?: NonNullable<TuiCommandDeps["popupControl"]>;
    sendError?: Error;
    source?: boolean;
  } = {},
) {
  const fixture = await createTempState();
  const child = new FakeRendererChild(options.sendError ?? null);
  const linkChild = new EventEmitter();
  const linkExitCode = options.linkExitCode ?? 0;
  const spawnProcess = vi.fn(() => {
    if (options.source === true && spawnProcess.mock.calls.length === 1) {
      queueMicrotask(() => linkChild.emit("exit", linkExitCode));
      return linkChild as never;
    }
    return child as never;
  });
  const popupControl =
    options.popupControl ??
    ({
      dismissPopup: async () => ({ dismissed: true }),
      resolveFocusTarget: async () => focusTarget("client-a"),
    } satisfies NonNullable<TuiCommandDeps["popupControl"]>);
  const result = runTuiCommand(
    ["--popup", "--persistent"],
    { config: fixture.config },
    {
      observer: runningObserverDeps(),
      selfExecRuntime:
        options.source === true
          ? { compiled: false, execPath: "/unused/stn" }
          : { compiled: true, execPath: "/opt/station/stn" },
      stationUiInstalled: async () => true,
      spawnProcess: spawnProcess as never,
      popupControl,
    },
  );
  const expectedSpawnCount = options.source === true && linkExitCode === 0 ? 2 : 1;
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(expectedSpawnCount));

  return {
    child,
    spawnProcess,
    finish: async () => {
      if (options.source === true && linkExitCode !== 0) {
        await expect(result).resolves.toEqual({ status: "exited", code: linkExitCode });
        return;
      }
      child.emit("exit", 0);
      await expect(result).resolves.toEqual({ status: "exited", code: 0 });
    },
  };
}

function controlRequest(
  requestId: string,
  type: "dismiss" | "resolve-focus-target",
): { protocolVersion: 1; requestId: string; type: "dismiss" | "resolve-focus-target" } {
  return { protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION, requestId, type };
}

function focusTarget(
  clientId: string,
  dismissExact: () => Promise<{ dismissed: boolean }> = async () => ({ dismissed: true }),
) {
  return {
    origin: { provider: "tmux", clientId },
    dismissExact,
  };
}
