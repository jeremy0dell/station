import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@station/cli";
import {
  type ObserverProcessDeps,
  runPopupCommand,
  shouldSuppressCliProcessOutput,
} from "@station/cli/internal";
import type { TerminalPopupResult } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";
const buildIdentity = "a".repeat(64);
const observerBuildVersion = `0.0.0-local+station.${buildIdentity}`;
const higherObserverBuildVersion = `0.0.0-pre-alpha.14.8+station.${buildIdentity}`;
const tuiObserverBuildMismatchError = {
  tag: "TuiCommandError",
  code: "TUI_OBSERVER_BUILD_MISMATCH",
  message: `Station UI caller selector "${observerBuildVersion}" does not match accepted Observer selector "${higherObserverBuildVersion}"; launch was refused before Station Host-producing work could mix builds.`,
  hint: `Use the matching Observer build "${higherObserverBuildVersion}" to account for live terminals. When hosted work is empty, stop the incumbent Observer and retry, or use isolated Observer state.`,
} as const;
const openedPopup = async (): Promise<TerminalPopupResult> => ({ opened: true });
describe("CLI popup command", () => {
  it("ensures the observer before opening a config-less first-run popup", async () => {
    const fixture = await createTempState();
    const calls: string[] = [];
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
              schemaVersion: "0.13.0",
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
          popup: {
            open: async () => {
              lifecycle.push("popup-open");
              calls.push("opened");
              return { opened: true };
            },
          },
        },
      }),
    );
    expect(result).toEqual({ code: 0, output: { opened: true } });
    expect(lifecycle).toEqual(["observer-spawn", "popup-open"]);
    expect(calls).toHaveLength(1);
    await expect(access(join(fixture.root, ".config/station/config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("reports slow observer startup before opening the popup", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    let spawned = false;
    let markSpawned = (): void => {};
    let releaseHealth = (): void => {};
    const observerSpawned = new Promise<void>((resolve) => {
      markSpawned = () => resolve();
    });
    const healthReady = new Promise<void>((resolve) => {
      releaseHealth = () => resolve();
    });
    const openPopup = vi.fn(openedPopup);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const resultPromise = runPopupCommand(
        [],
        {
          config: fixture.config,
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
                    schemaVersion: "0.13.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: observerBuildVersion,
                  };
                },
                reconcile: async () => emptySnapshot("popup-open"),
              }) as never,
          },
          popup: { open: openPopup },
        },
      );
      await observerSpawned;
      await vi.advanceTimersByTimeAsync(1499);
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(openPopup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(1, "Starting STATION observer…\n");
      await vi.advanceTimersByTimeAsync(3499);
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(openPopup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stderrWrite).toHaveBeenNthCalledWith(
        2,
        `Still waiting for STATION observer; boot log: ${join(fixture.stateDir, "logs/observer-boot.log")}\n`,
      );
      expect(openPopup).not.toHaveBeenCalled();
      releaseHealth();
      await expect(resultPromise).resolves.toEqual({ opened: true });
      expect(openPopup).toHaveBeenCalledOnce();
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
    const openPopup = vi.fn(openedPopup);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        runPopupCommand(
          [],
          {
            config: fixture.config,
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
                    schemaVersion: "0.13.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: observerBuildVersion,
                  }),
                  reconcile: async () => emptySnapshot("popup-open"),
                }) as never,
            },
            popup: { open: openPopup },
          },
        ),
      ).resolves.toEqual({ opened: true });
      expect(stderrWrite).not.toHaveBeenCalled();
      expect(openPopup).toHaveBeenCalledOnce();
    } finally {
      stderrWrite.mockRestore();
    }
  });
  it("refuses a lower-build popup before reconcile or configured, warm, and registered routing", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const reconcile = vi.fn(async () => emptySnapshot("unexpected"));
    const spawnObserver = vi.fn(async () => ({ pid: 5678, unref: () => undefined }));
    const clientFactory = vi.fn(
      () =>
        ({
          health: async () => ({
            schemaVersion: "0.13.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: higherObserverBuildVersion,
          }),
          reconcile,
        }) as never,
    );
    const openPopup = vi.fn(openedPopup);
    await expect(
      runPopupCommand(
        [],
        {
          config: fixture.config,
        },
        {
          observer: {
            buildVersion: observerBuildVersion,
            clientFactory,
            spawnObserver,
          },
          popup: { open: openPopup },
        },
      ),
    ).rejects.toEqual(tuiObserverBuildMismatchError);
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(spawnObserver).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(openPopup).not.toHaveBeenCalled();
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
          popup: {
            open: async () => {
              throw new Error("popup should not open for an explicit missing config");
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_FILE_NOT_FOUND", configPath });
  });
  it("does not open a first-run popup when the observer exits during startup", async () => {
    const fixture = await createTempState();
    const openPopup = vi.fn(openedPopup);
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
          popup: { open: openPopup },
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
    expect(openPopup).not.toHaveBeenCalled();
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
            popup: {
              open: async () => {
                throw new Error("popup should not open for malformed config");
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_TOML_PARSE_FAILED", configPath });
  });
  it("does not block popup opening on observer reconcile", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "tmux";
    const calls: string[] = [];
    const reconciles: string[] = [];
    const result = await expectWithin(
      runPopupCommand(
        [],
        {
          config: fixture.config,
        },
        {
          observer: nonCompletingReconcileObserverDeps(reconciles),
          popup: {
            open: async () => {
              calls.push("opened");
              return { opened: true };
            },
          },
        },
      ),
      100,
    );
    expect(result).toEqual({ opened: true });
    expect(reconciles).toEqual(["popup-open"]);
    expect(calls).toHaveLength(1);
  });
  it("opens through a non-tmux capability using the public command", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "fixture-terminal";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const openPopup = vi.fn(openedPopup);
    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: runningObserverDeps([]),
        popupDeps: { popup: { open: openPopup } },
      }),
    ).resolves.toEqual({ code: 0, output: { opened: true } });
    expect(openPopup).toHaveBeenCalledOnce();
  });
  it("rejects unsupported providers before Observer startup", async () => {
    const fixture = await createTempState();
    fixture.config.defaults.terminal = "fixture-terminal";
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const spawnObserver = vi.fn();
    await expect(
      runCli(["--config", configPath, "popup"], {
        observerDeps: { spawnObserver },
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_POPUP_UNSUPPORTED", provider: "fixture-terminal" });
    expect(spawnObserver).not.toHaveBeenCalled();
  });
  it("preserves the selected capability's error without another launch", async () => {
    const openPopup = vi.fn(async () => {
      throw new Error("fixture unavailable");
    });
    await expect(runPopupCommand([], {}, { popup: { open: openPopup } })).rejects.toThrow(
      "fixture unavailable",
    );
    expect(openPopup).toHaveBeenCalledOnce();
  });
  it("suppresses explicit popup command JSON in the interactive CLI process", () => {
    expect(shouldSuppressCliProcessOutput(["popup"])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["popup", "--config", "/tmp/config.toml"])).toBe(true);
    expect(shouldSuppressCliProcessOutput([])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["tui"])).toBe(true);
    expect(shouldSuppressCliProcessOutput(["doctor"])).toBe(false);
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
function runningObserverDeps(reconciles: string[]): ObserverProcessDeps {
  return {
    buildVersion: observerBuildVersion,
    clientFactory: () =>
      ({
        health: async () => ({
          schemaVersion: "0.13.0",
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
    schemaVersion: "0.13.0",
    reason,
    reconciledAt: now,
    snapshot: {
      schemaVersion: "0.13.0",
      generatedAt: now,
      observer: { pid: 1234, startedAt: now, version: "0.7.0", healthy: true },
      providerHealth: {},
      projects: [],
      rows: [],
      sessions: [],
      sessionGroups: [],
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
          schemaVersion: "0.13.0",
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
