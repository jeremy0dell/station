import { realpathSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "@station/cli";
import {
  type ObserverProcessDeps,
  runPopupCommand,
  shouldSuppressCliProcessOutput,
} from "@station/cli/internal";
import type { TmuxPopupOptions } from "@station/tmux";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";
const observerBuildVersion = `0.7.0+station.${"a".repeat(64)}`;
const repoRoot = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url))).replace(
  /\/$/,
  "",
);

describe("CLI popup command", () => {
  it("ensures the observer before opening a config-less first-run popup", async () => {
    const fixture = await createTempState();
    const calls: TmuxPopupOptions[] = [];
    const lifecycle: string[] = [];
    let running = false;
    const observerDeps: ObserverProcessDeps = {
      buildVersion: observerBuildVersion,
      spawnObserver: async () => {
        lifecycle.push("observer-spawn");
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
              version: observerBuildVersion,
            };
          },
          reconcile: async () => emptySnapshot("popup-open"),
        }) as never,
      sleep: async () => undefined,
    };

    const result = await withIsolatedHome(fixture.root, () =>
      runCli([], {
        observerDeps,
        popupDeps: {
          env: { TMUX: "/tmp/tmux-501/default,123,0" },
          openTmuxPopup: async (options) => {
            lifecycle.push("popup-open");
            calls.push(options);
            return { opened: true };
          },
        },
      }),
    );

    expect(result).toEqual({ code: 0, output: { opened: true } });
    expect(lifecycle).toEqual(["observer-spawn", "popup-open"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tuiCommand).toContain("tui --popup --persistent");
    expect(calls[0]?.tuiCommand).not.toContain("--config");
    await expect(access(join(fixture.root, ".config/station/config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports slow observer startup before opening the popup", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    let spawned = false;
    let markSpawned = () => undefined;
    let releaseHealth = () => undefined;
    const observerSpawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const healthReady = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const openTmuxPopup = vi.fn(async () => ({ opened: true }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers();

    try {
      const resultPromise = runPopupCommand(
        [],
        {
          config: fixture.config,
          env: { TMUX: "/tmp/tmux-501/default,123,0" },
        },
        {
          observer: {
            buildVersion: observerBuildVersion,
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
                    version: observerBuildVersion,
                  };
                },
                reconcile: async () => emptySnapshot("popup-open"),
              }) as never,
          },
          openTmuxPopup,
        },
      );

      await observerSpawned;
      await vi.advanceTimersByTimeAsync(1_499);
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(openTmuxPopup).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(1, "Starting STATION observer…\n");

      await vi.advanceTimersByTimeAsync(3_499);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(openTmuxPopup).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(
        2,
        `Still waiting for STATION observer; boot log: ${join(
          fixture.stateDir,
          "logs/observer-boot.log",
        )}\n`,
      );
      expect(openTmuxPopup).not.toHaveBeenCalled();

      releaseHealth();
      await expect(resultPromise).resolves.toEqual({ opened: true });
      expect(openTmuxPopup).toHaveBeenCalledOnce();
    } finally {
      releaseHealth();
      vi.clearAllTimers();
      vi.useRealTimers();
      stderrWrite.mockRestore();
    }
  });

  it("keeps warm observer attachment silent", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const openTmuxPopup = vi.fn(async () => ({ opened: true }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(
        runPopupCommand(
          [],
          {
            config: fixture.config,
            env: { TMUX: "/tmp/tmux-501/default,123,0" },
          },
          {
            observer: {
              buildVersion: observerBuildVersion,
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
                    version: observerBuildVersion,
                  }),
                  reconcile: async () => emptySnapshot("popup-open"),
                }) as never,
            },
            openTmuxPopup,
          },
        ),
      ).resolves.toEqual({ opened: true });
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(openTmuxPopup).toHaveBeenCalledOnce();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("keeps an explicitly missing popup config as a hard error", async () => {
    const fixture = await createTempState();
    const configPath = join(fixture.root, "missing.toml");

    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: {
          spawnObserver: async () => {
            throw new Error("observer should not start for an explicit missing config");
          },
        },
        popupDeps: {
          env: { TMUX: "/tmp/tmux-501/default,123,0" },
          openTmuxPopup: async () => {
            throw new Error("popup should not open for an explicit missing config");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_FILE_NOT_FOUND", configPath });
  });

  it("does not open a first-run popup when the observer exits during startup", async () => {
    const fixture = await createTempState();
    const openTmuxPopup = vi.fn(async () => ({ opened: true }));

    const result = await withIsolatedHome(fixture.root, () =>
      runCli([], {
        observerDeps: {
          spawnObserver: async () => ({
            pid: 1234,
            unref: () => undefined,
            exited: Promise.resolve({ type: "exit" as const, code: 1, signal: null }),
          }),
          clientFactory: () =>
            ({
              health: async () => {
                throw new Error("stopped");
              },
            }) as never,
        },
        popupDeps: {
          env: { TMUX: "/tmp/tmux-501/default,123,0" },
          openTmuxPopup,
        },
      }),
    );

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "unavailable",
        observer: {
          status: "unhealthy",
          error: { code: "OBSERVER_EXITED_ON_START" },
        },
      },
    });
    expect(openTmuxPopup).not.toHaveBeenCalled();
  });

  it("keeps a malformed implicit popup config as a hard error", async () => {
    const fixture = await createTempState();
    const configPath = join(fixture.root, ".config/station/config.toml");
    await mkdir(join(fixture.root, ".config/station"), { recursive: true });
    await writeFile(configPath, "not = [valid toml", "utf8");

    await expect(
      withIsolatedHome(fixture.root, () =>
        runCli([], {
          popupDeps: {
            env: { TMUX: "/tmp/tmux-501/default,123,0" },
            openTmuxPopup: async () => {
              throw new Error("popup should not open for malformed config");
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_TOML_PARSE_FAILED", configPath });
  });

  it("delegates popup opening to the tmux integration", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    fixture.config.terminal = {
      tmux: {
        popupWidth: "90%",
        popupHeight: "80%",
        popupPosition: "C",
      },
    };
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];

    await expect(
      runPopupCommand(
        [],
        {
          config: fixture.config,
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
          tuiCommand: "node stn tui --popup --persistent",
        },
        {
          observer: runningObserverDeps(reconciles),
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      ),
    ).resolves.toEqual({ opened: true });

    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toEqual([
      {
        config: {
          popupWidth: "90%",
          popupHeight: "80%",
          popupPosition: "C",
        },
        enterWorkbench: false,
        env: {
          TMUX: "/tmp/tmux-501/default,123,0",
        },
        tuiCommand: "node stn tui --popup --persistent",
      },
    ]);
  });

  it("does not block popup opening on observer reconcile", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];

    const result = await expectWithin(
      runPopupCommand(
        [],
        {
          config: fixture.config,
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
        },
        {
          observer: nonCompletingReconcileObserverDeps(reconciles),
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      ),
      100,
    );

    expect(result).toEqual({ opened: true });
    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
  });

  it("routes runCli popup through global --config parsing", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];

    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: runningObserverDeps(reconciles),
        popupDeps: {
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      }),
    ).resolves.toEqual({
      code: 0,
      output: { opened: true },
    });

    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      checkoutRoot: repoRoot,
      env: {
        TMUX: "/tmp/tmux-501/default,123,0",
      },
      preferRegisteredDevPopup: true,
    });
    expect(calls[0]?.tuiCommand).toBe(
      [
        shellQuote(process.execPath),
        shellQuote(fileURLToPath(new URL("../../src/main.ts", import.meta.url))),
        "--config",
        shellQuote(configPath),
        "tui",
        "--popup",
        "--persistent",
      ].join(" "),
    );
  });

  it("prefers an injected installed popup owner over the source checkout", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];

    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: runningObserverDeps([]),
        popupDeps: {
          checkoutRoot: "/opt/station/current",
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
          preferRegisteredDevPopup: false,
        },
      }),
    ).resolves.toEqual({
      code: 0,
      output: { opened: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.checkoutRoot).toBe("/opt/station/current");
    expect(calls[0]?.preferRegisteredDevPopup).toBe(false);
  });

  it("omits an unsafe filesystem-root popup owner", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];

    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: runningObserverDeps([]),
        popupDeps: {
          checkoutRoot: "/",
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      }),
    ).resolves.toEqual({
      code: 0,
      output: { opened: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("checkoutRoot");
  });

  it("defaults bare station to the popup command when invoked from tmux", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];

    await expect(
      runCli(["--config", configPath], {
        observerDeps: runningObserverDeps(reconciles),
        popupDeps: {
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
          },
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      }),
    ).resolves.toEqual({
      code: 0,
      output: { opened: true },
    });

    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.checkoutRoot).toBe(repoRoot);
    expect(calls[0]?.preferRegisteredDevPopup).toBe(true);
  });

  it("uses the configured TUI command and UI session name for dev popup placement", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];

    await expect(
      runCli(["--config", configPath], {
        observerDeps: runningObserverDeps(reconciles),
        popupDeps: {
          env: {
            TMUX: "/tmp/tmux-501/default,123,0",
            STATION_TUI_COMMAND: "node --watch --watch-preserve-output apps/cli/dist/main.js",
            STATION_TUI_SESSION_NAME: "_station-ui-dev",
          },
          openTmuxPopup: async (options) => {
            calls.push(options);
            return { opened: true };
          },
        },
      }),
    ).resolves.toEqual({
      code: 0,
      output: { opened: true },
    });

    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tuiCommand).toBe(
      [
        "node --watch --watch-preserve-output apps/cli/dist/main.js",
        "--config",
        shellQuote(configPath),
        "tui",
        "--popup",
        "--persistent",
      ].join(" "),
    );
    expect(calls[0]?.preferRegisteredDevPopup).toBe(false);
    expect(calls[0]?.checkoutRoot).toBe(repoRoot);
    expect(calls[0]?.uiSessionName).toBe("_station-ui-dev");
  });

  it("reads the dev TUI command from the real process environment", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const calls: TmuxPopupOptions[] = [];
    const reconciles: string[] = [];
    const previousCommand = process.env.STATION_TUI_COMMAND;
    const previousSessionName = process.env.STATION_TUI_SESSION_NAME;
    process.env.STATION_TUI_COMMAND = "node --watch apps/cli/dist/main.js";
    process.env.STATION_TUI_SESSION_NAME = "_station-ui-dev";
    try {
      await expect(
        runCli(["--config", configPath, "popup"], {
          observerDeps: runningObserverDeps(reconciles),
          popupDeps: {
            openTmuxPopup: async (options) => {
              calls.push(options);
              return { opened: true };
            },
          },
        }),
      ).resolves.toEqual({
        code: 0,
        output: { opened: true },
      });
    } finally {
      if (previousCommand === undefined) {
        delete process.env.STATION_TUI_COMMAND;
      } else {
        process.env.STATION_TUI_COMMAND = previousCommand;
      }
      if (previousSessionName === undefined) {
        delete process.env.STATION_TUI_SESSION_NAME;
      } else {
        process.env.STATION_TUI_SESSION_NAME = previousSessionName;
      }
    }

    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tuiCommand).toContain("node --watch apps/cli/dist/main.js");
    expect(calls[0]?.tuiCommand).toContain("tui --popup --persistent");
    expect(calls[0]?.preferRegisteredDevPopup).toBe(false);
    expect(calls[0]?.checkoutRoot).toBe(repoRoot);
    expect(calls[0]?.uiSessionName).toBe("_station-ui-dev");
  });

  it("rejects popup when the configured terminal provider is not tmux", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "ghostty";

    await expect(runPopupCommand([], { config: fixture.config })).rejects.toThrow(
      "Popup is only implemented for tmux, not ghostty.",
    );
  });

  it("suppresses explicit popup command JSON in the interactive CLI process", () => {
    expect(shouldSuppressCliProcessOutput(["popup"])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["popup", "--config", "/tmp/config.toml"])).toBe(true);
    expect(shouldSuppressCliProcessOutput([])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["tui"])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["doctor"])).toBe(false);
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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

function runningObserverDeps(reconciles: string[]): ObserverProcessDeps {
  return {
    buildVersion: observerBuildVersion,
    clientFactory: () =>
      ({
        health: async () => ({
          schemaVersion: "0.8.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: observerBuildVersion,
        }),
        reconcile: async (reason: string) => {
          reconciles.push(reason);
          return emptySnapshot(reason);
        },
      }) as never,
    sleep: async () => undefined,
  };
}

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

function nonCompletingReconcileObserverDeps(reconciles: string[]): ObserverProcessDeps {
  return {
    buildVersion: observerBuildVersion,
    clientFactory: () =>
      ({
        health: async () => ({
          schemaVersion: "0.8.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: observerBuildVersion,
        }),
        reconcile: (reason: string) => {
          reconciles.push(reason);
          return new Promise(() => undefined);
        },
      }) as never,
    sleep: async () => undefined,
  };
}
