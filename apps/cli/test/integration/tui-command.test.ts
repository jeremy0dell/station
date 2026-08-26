import { EventEmitter } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@station/cli";
import {
  type ObserverProcessDeps,
  resolvePopupTmuxCommand,
  runCliMain,
  runTuiCommand,
  type TuiCommandDeps,
} from "@station/cli/internal";
import { loadConfig, setTuiWidgetsInConfig, type TuiConfig } from "@station/config";
import { TUI_RENDERER_CONTROL_PROTOCOL_VERSION } from "@station/contracts";
import { readJsonlLog } from "@station/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { resolveStationWorkspaceDir } from "../../src/stationWorkspace.js";

const now = "2026-05-20T12:00:00.000Z";
const buildIdentity = "a".repeat(64);
const observerBuildVersion = `0.0.0-local+station.${buildIdentity}`;
const higherObserverBuildVersion = `0.0.0-pre-alpha.8.2+station.${buildIdentity}`;
const nestedTuiDisabledError = {
  tag: "TuiCommandError",
  code: "NESTED_TUI_DISABLED",
  message: "Nested Station is disabled.",
  hint: "Press Ctrl-O to open Station, or use `stn tui --allow-nested` for testing.",
} as const;
const tuiObserverBuildMismatchError = {
  tag: "TuiCommandError",
  code: "TUI_OBSERVER_BUILD_MISMATCH",
  message: `Station UI caller selector "${observerBuildVersion}" does not match accepted Observer selector "${higherObserverBuildVersion}"; launch was refused before Station Host-producing work could mix builds.`,
  hint: `Use the matching Observer build "${higherObserverBuildVersion}" to account for live terminals. When hosted work is empty, stop the incumbent Observer and retry, or use isolated Observer state.`,
} as const;
const inheritedStationPane = process.env.STATION_PANE;
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
    schemaVersion: "0.11.0",
    reason,
    reconciledAt: now,
    snapshot: {
      schemaVersion: "0.11.0",
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

// A running observer whose health check passes once spawned. `reconcile`
// records its reason (or hangs, to model the non-blocking startup reconcile).
type SpawnObserverInput = Parameters<NonNullable<ObserverProcessDeps["spawnObserver"]>>[0];

function runningObserverDeps(
  options: {
    reconciles?: string[];
    hangReconcile?: boolean;
    spawns?: SpawnObserverInput[];
    onSpawn?: () => void;
  } = {},
) {
  let running = false;
  return {
    buildVersion: observerBuildVersion,
    spawnObserver: async (input: SpawnObserverInput) => {
      options.spawns?.push(input);
      options.onSpawn?.();
      running = true;
      return { pid: 1234, unref: () => undefined };
    },
    clientFactory: () =>
      ({
        health: async () => {
          if (!running) throw new Error("stopped");
          return {
            schemaVersion: "0.11.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: observerBuildVersion,
          };
        },
        reconcile: (reason: string) => {
          options.reconciles?.push(reason);
          if (options.hangReconcile === true) {
            return new Promise(() => undefined);
          }
          return Promise.resolve(emptySnapshot(reason));
        },
        getSnapshot: async () => emptySnapshot("nested-snapshot").snapshot,
      }) as never,
    sleep: async () => undefined,
  };
}

function warmObserverDeps(version: string): ObserverProcessDeps {
  return {
    buildVersion: observerBuildVersion,
    clientFactory: () =>
      ({
        health: async () => ({
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version,
        }),
      }) as never,
  };
}

type TuiUpdateProbe = NonNullable<TuiCommandDeps["updateProbes"]>[number];
type TuiUpdatePlan = NonNullable<Awaited<ReturnType<TuiUpdateProbe["detectAndPlan"]>>>["plan"];

function updateProbe(
  overrides: Partial<TuiUpdatePlan> = {},
  apply?: NonNullable<Awaited<ReturnType<TuiUpdateProbe["detectAndPlan"]>>>["apply"],
): TuiUpdateProbe {
  const plan: TuiUpdatePlan = {
    channel: "installer-binary",
    status: "update-available",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    currentCli: ["stn"],
    ...overrides,
  };
  return {
    channel: plan.channel,
    detectAndPlan: async () => ({
      channel: plan.channel,
      plan,
      apply:
        apply ??
        (async () => ({
          channel: plan.channel,
          status: "updated",
          previousVersion: plan.currentVersion,
          installedVersion: plan.targetVersion,
          warnings: [],
        })),
    }),
  };
}

describe("CLI tui command", () => {
  beforeEach(() => {
    delete process.env.STATION_PANE;
  });

  afterEach(() => {
    if (inheritedStationPane === undefined) delete process.env.STATION_PANE;
    else process.env.STATION_PANE = inheritedStationPane;
  });

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
        startupTimeoutMs: expect.any(Number),
      },
    ]);
    expect(envs).toEqual([
      {
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: join(fixture.root, ".local/state/station/run/observer.sock"),
      },
    ]);
    await expect(access(join(fixture.root, ".config/station/config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("captures one caller build before startup even when the checkout changes while awaiting it", async () => {
    const fixture = await createTempState();
    const envs: Array<Record<string, string>> = [];
    let currentBuildVersion = observerBuildVersion;
    const changedBuildVersion = `0.7.0+station.${"b".repeat(64)}`;
    const { buildVersion: _ignoredBuildVersion, ...observerDeps } = runningObserverDeps({
      onSpawn: () => {
        currentBuildVersion = changedBuildVersion;
      },
    });
    const readBuildVersion = vi.fn(() => currentBuildVersion);

    const result = await runTuiCommand(
      [],
      { config: fixture.config },
      {
        observer: observerDeps,
        buildVersion: readBuildVersion,
        spawnRenderer: async ({ env }) => {
          envs.push(env);
          return { status: "exited", code: 0 };
        },
      },
    );

    expect(result).toEqual({ status: "exited", code: 0 });
    expect(readBuildVersion).toHaveBeenCalledTimes(1);
    expect(currentBuildVersion).toBe(changedBuildVersion);
    expect(envs).toEqual([
      {
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
      },
    ]);
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
    expect(envs).toEqual([
      {
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
      },
    ]);
    // The startup reconcile is deferred and never awaited: not yet run when the
    // renderer resolves, then fires as "tui-startup".
    expect(reconciles).toEqual([]);
    await vi.waitFor(() => expect(reconciles).toEqual(["tui-startup"]));
  });

  it("prints one actionable update notice after native renderer cleanup without applying", async () => {
    const fixture = await createTempState();
    const events: string[] = [];
    const apply = vi.fn(async () => ({
      channel: "installer-binary" as const,
      status: "updated" as const,
      previousVersion: "1.0.0",
      installedVersion: "1.1.0",
      warnings: [],
    }));
    const probe = updateProbe({}, apply);
    const detectAndPlan = vi.fn(async (operation = {}) => {
      events.push("discovery-started");
      expect(operation.signal?.aborted).toBe(false);
      const planned = await probe.detectAndPlan(operation);
      events.push("discovery-completed");
      return planned;
    });
    const writeUpdateNotice = vi.fn((notice: string) => {
      events.push("notice-written");
      expect(notice).toBe("Station 1.1.0 is available — run `stn update`\n");
    });

    const resultPromise = runTuiCommand(
      [],
      { config: fixture.config },
      {
        observer: runningObserverDeps(),
        spawnRenderer: async () => {
          events.push("renderer-started");
          await new Promise<void>((resolve) => setImmediate(resolve));
          events.push("renderer-cleaned-up");
          return { status: "exited", code: 0 };
        },
        updateProbes: [{ channel: "installer-binary", detectAndPlan }],
        writeUpdateNotice,
      },
    );

    await expect(resultPromise).resolves.toEqual({ status: "exited", code: 0 });
    expect(events).toEqual([
      "renderer-started",
      "discovery-started",
      "discovery-completed",
      "renderer-cleaned-up",
      "notice-written",
    ]);
    expect(detectAndPlan).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(writeUpdateNotice).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "current plan",
      probes: [updateProbe({ status: "current", targetVersion: "1.0.0" })],
    },
    {
      label: "same-version revision-only plan",
      probes: [
        updateProbe({
          channel: "dev-checkout",
          currentVersion: "1.0.0-dev",
          targetVersion: "1.0.0-dev",
          currentRevision: "aaaaaaaa",
          targetRevision: "bbbbbbbb",
          currentCli: ["node", "apps/cli/dist/main.js"],
        }),
      ],
    },
    {
      label: "missing owner",
      probes: [
        {
          channel: "installer-binary" as const,
          detectAndPlan: async () => undefined,
        },
      ],
    },
    {
      label: "ambiguous owner",
      probes: [updateProbe(), updateProbe({ channel: "homebrew" })],
    },
    {
      label: "failed discovery",
      probes: [
        {
          channel: "installer-binary" as const,
          detectAndPlan: async () => {
            throw new Error("release lookup failed");
          },
        },
      ],
    },
  ] satisfies Array<{
    label: string;
    probes: TuiUpdateProbe[];
  }>)("omits the update notice for $label", async ({ probes }) => {
    const fixture = await createTempState();
    const writeUpdateNotice = vi.fn();

    await expect(
      runTuiCommand(
        [],
        { config: fixture.config },
        {
          observer: runningObserverDeps(),
          spawnRenderer: async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return { status: "exited", code: 0 };
          },
          updateProbes: probes,
          writeUpdateNotice,
        },
      ),
    ).resolves.toEqual({ status: "exited", code: 0 });

    expect(writeUpdateNotice).not.toHaveBeenCalled();
  });

  it("aborts unfinished discovery without awaiting it", async () => {
    const fixture = await createTempState();
    let discoveryStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    let discoverySignal: AbortSignal | undefined;
    const detectAndPlan = vi.fn(
      (operation = {}) =>
        new Promise<never>((_resolve, reject) => {
          discoverySignal = operation.signal;
          discoveryStarted();
          operation.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const writeUpdateNotice = vi.fn();

    await expect(
      runTuiCommand(
        [],
        { config: fixture.config },
        {
          observer: runningObserverDeps(),
          spawnRenderer: async () => {
            await started;
            return { status: "exited", code: 0 };
          },
          updateProbes: [{ channel: "installer-binary", detectAndPlan }],
          writeUpdateNotice,
        },
      ),
    ).resolves.toEqual({ status: "exited", code: 0 });

    expect(detectAndPlan).toHaveBeenCalledOnce();
    expect(discoverySignal?.aborted).toBe(true);
    expect(writeUpdateNotice).not.toHaveBeenCalled();
  });

  it("never discovers updates for popup or fake-dashboard renderers", async () => {
    const fixture = await createTempState();
    const detectAndPlan = vi.fn(async () => undefined);
    const updateProbes = [{ channel: "installer-binary" as const, detectAndPlan }];
    const writeUpdateNotice = vi.fn();
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));

    await expect(
      runTuiCommand(
        ["--popup"],
        { config: fixture.config },
        {
          observer: runningObserverDeps(),
          spawnRenderer,
          updateProbes,
          writeUpdateNotice,
        },
      ),
    ).resolves.toEqual({ status: "exited", code: 0 });
    await expect(
      runTuiCommand(
        ["--dev-fake-dashboard"],
        { config: fixture.config },
        { spawnRenderer, updateProbes, writeUpdateNotice },
      ),
    ).resolves.toEqual({ status: "exited", code: 0 });

    expect(spawnRenderer).toHaveBeenCalledTimes(2);
    expect(detectAndPlan).not.toHaveBeenCalled();
    expect(writeUpdateNotice).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "nonzero exit",
      result: { status: "exited" as const, code: 1 },
    },
    {
      label: "signal-bearing exit",
      result: {
        status: "exited" as const,
        code: 0,
        exitCode: null,
        signal: "SIGTERM" as const,
      },
    },
  ])("omits the update notice after a $label", async ({ result }) => {
    const fixture = await createTempState();
    const writeUpdateNotice = vi.fn();

    await expect(
      runTuiCommand(
        [],
        { config: fixture.config },
        {
          observer: runningObserverDeps(),
          spawnRenderer: async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return result;
          },
          updateProbes: [updateProbe()],
          writeUpdateNotice,
        },
      ),
    ).resolves.toEqual(result);

    expect(writeUpdateNotice).not.toHaveBeenCalled();
  });

  it("reports slow observer startup before opening the native renderer", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let markSpawned: () => void = () => {};
    let releaseHealth: () => void = () => {};
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
                    schemaVersion: "0.11.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: observerBuildVersion,
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
              buildVersion: observerBuildVersion,
              spawnObserver: async () => {
                throw new Error("observer should not spawn for a warm attachment");
              },
              clientFactory: () =>
                ({
                  health: async () => ({
                    schemaVersion: "0.11.0",
                    status: "healthy",
                    pid: 1234,
                    startedAt: now,
                    version: observerBuildVersion,
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

  it.each([
    { label: "native Station", args: [] },
    { label: "direct popup dashboard", args: ["--popup"] },
  ])("refuses a lower-build $label before UI effects", async ({ args }) => {
    const fixture = await createTempState();
    const reconcile = vi.fn(async () => emptySnapshot("unexpected"));
    const spawnObserver = vi.fn(async () => ({ pid: 5678, unref: () => undefined }));
    const clientFactory = vi.fn(
      () =>
        ({
          health: async () => ({
            schemaVersion: "0.11.0",
            status: "healthy",
            pid: 1234,
            startedAt: now,
            version: higherObserverBuildVersion,
          }),
          reconcile,
        }) as never,
    );
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));
    const stationUiInstalled = vi.fn(async () => true);
    const spawnProcess = vi.fn();
    vi.useFakeTimers();

    try {
      await expect(
        runTuiCommand(
          args,
          { config: fixture.config },
          {
            observer: {
              buildVersion: observerBuildVersion,
              clientFactory,
              spawnObserver,
            },
            spawnRenderer,
            stationUiInstalled,
            spawnProcess: spawnProcess as never,
          },
        ),
      ).rejects.toEqual(tuiObserverBuildMismatchError);

      await vi.advanceTimersByTimeAsync(251);
      expect(clientFactory).toHaveBeenCalledOnce();
      expect(spawnObserver).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(spawnRenderer).not.toHaveBeenCalled();
      expect(stationUiInstalled).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
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
    expect(envs).toEqual([
      {
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
      },
    ]);
  });

  it.each([
    { label: "bare native launch", args: [], env: { STATION_PANE: "1" } },
    { label: "explicit native launch", args: ["tui"], env: { STATION_PANE: "1" } },
    {
      label: "native launch from a Station workspace running inside tmux",
      args: ["tui"],
      env: {
        STATION_PANE: JSON.stringify(["/tmp/tmux-501/default,123,0", "%4"]),
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%4",
      },
    },
    {
      label: "direct popup renderer launch",
      args: ["tui", "--popup"],
      env: { STATION_PANE: "1" },
    },
  ])("blocks $label before Observer or renderer effects", async ({ args, env }) => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const health = vi.fn();
    const reconcile = vi.fn();
    const spawnObserver = vi.fn(async () => ({ pid: 1234, unref: () => undefined }));
    const clientFactory = vi.fn(
      () =>
        ({
          health,
          reconcile,
        }) as never,
    );
    const stationUiInstalled = vi.fn(async () => true);
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));

    await expect(
      runCli(["--config", configPath, ...args], {
        env,
        observerDeps: { clientFactory, spawnObserver },
        tuiDeps: { spawnRenderer, stationUiInstalled },
      }),
    ).rejects.toEqual(nestedTuiDisabledError);

    expect(spawnObserver).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(stationUiInstalled).not.toHaveBeenCalled();
    expect(spawnRenderer).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "different pane on the same tmux server",
      currentTmux: "/tmp/tmux-501/station-origin,123,0",
      currentPane: "%8",
    },
    {
      label: "same-numbered pane on another tmux server",
      currentTmux: "/tmp/tmux-501/later-server,456,0",
      currentPane: "%0",
    },
  ])("ignores a Station marker copied into a $label", async ({ currentTmux, currentPane }) => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const launches: Array<{ entry: string }> = [];
    const originTmux = "/tmp/tmux-501/station-origin,123,0";

    await expect(
      runCli(["--config", configPath, "tui"], {
        env: {
          STATION_PANE: JSON.stringify([originTmux, "%0"]),
          TMUX: currentTmux,
          TMUX_PANE: currentPane,
        },
        observerDeps: runningObserverDeps(),
        tuiDeps: {
          spawnRenderer: async ({ entry }) => {
            launches.push({ entry });
            return { status: "exited", code: 0 };
          },
        },
      }),
    ).resolves.toEqual({ code: 0, output: { status: "exited", code: 0 } });

    expect(launches).toEqual([{ entry: "station" }]);
  });

  it("requires the override again at each nested native depth", async () => {
    const fixture = await createTempState();
    const spawnRenderer = vi.fn(async () => ({ status: "exited" as const, code: 0 }));
    const runNested = (args: string[]) =>
      runTuiCommand(
        args,
        { config: fixture.config },
        {
          env: { STATION_PANE: "1" },
          observer: runningObserverDeps(),
          spawnRenderer,
        },
      );

    await expect(runNested(["--allow-nested"])).resolves.toEqual({
      status: "exited",
      code: 0,
    });
    await expect(runNested([])).rejects.toEqual(nestedTuiDisabledError);
    await expect(runNested(["--allow-nested"])).resolves.toEqual({
      status: "exited",
      code: 0,
    });
    expect(spawnRenderer).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "transient launcher child",
      args: ["--popup"],
      env: { STATION_PANE: "1", STATION_TUI_POPUP: "1" },
      expectedPersistent: false,
    },
    {
      label: "persistent launcher child",
      args: ["--popup", "--persistent"],
      env: { STATION_PANE: "1", STATION_TUI_POPUP: "1" },
      expectedPersistent: true,
    },
    {
      label: "direct popup with explicit override",
      args: ["--popup", "--allow-nested"],
      env: { STATION_PANE: "1" },
      expectedPersistent: false,
    },
  ])("allows $label", async ({ args, env, expectedPersistent }) => {
    const fixture = await createTempState();
    const launches: Array<{ entry: string; env: Record<string, string> }> = [];

    await expect(
      runTuiCommand(
        args,
        { config: fixture.config },
        {
          env,
          observer: runningObserverDeps(),
          spawnRenderer: async (launch) => {
            launches.push(launch);
            return { status: "exited", code: 0 };
          },
        },
      ),
    ).resolves.toEqual({ status: "exited", code: 0 });

    expect(launches).toHaveLength(1);
    expect(launches[0]?.entry).toBe("dashboard");
    expect(launches[0]?.env.STATION_TUI_POPUP).toBe("1");
    expect(launches[0]?.env.STATION_TUI_PERSISTENT).toBe(expectedPersistent ? "1" : undefined);
  });

  it("keeps non-TUI routes and help available inside a Station pane", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const env = { STATION_PANE: "1" };

    await expect(
      runCli(["--config", configPath, "snapshot", "--json"], {
        env,
        observerDeps: runningObserverDeps(),
      }),
    ).resolves.toEqual({
      code: 0,
      output: emptySnapshot("nested-snapshot").snapshot,
    });

    for (const topic of ["doctor", "debug", "observer", "command", "setup"]) {
      const result = await runCli([topic, "--help"], { env });
      expect(result.code).toBe(0);
      expect(result.output).toContain("Usage");
    }

    const tuiHelp = await runCli(["tui", "--help"], { env });
    expect(tuiHelp).toMatchObject({ code: 0 });
    expect(tuiHelp.output).toContain("--allow-nested");
    await expect(runCli(["--help"], { env })).resolves.toMatchObject({ code: 0 });
    await expect(runCli(["--version"], { env })).resolves.toMatchObject({ code: 0 });
  });

  it("prints the nested launch SafeError and exits one through the CLI process adapter", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runCliMain(["--config", configPath, "tui"], {
        env: { STATION_PANE: "1" },
      });

      expect(stderrWrite).toHaveBeenCalledWith(
        [
          "Nested Station is disabled. (NESTED_TUI_DISABLED)",
          "Hint: Press Ctrl-O to open Station, or use `stn tui --allow-nested` for testing.",
          "",
        ].join("\n"),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("prints UI build refusal as a SafeError without a JSON result envelope", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runCliMain(["--config", configPath, "tui"], {
        observerDeps: warmObserverDeps(higherObserverBuildVersion),
      });

      expect(stderrWrite).toHaveBeenCalledWith(
        [
          `${tuiObserverBuildMismatchError.message} (TUI_OBSERVER_BUILD_MISMATCH)`,
          `Hint: ${tuiObserverBuildMismatchError.hint}`,
          "",
        ].join("\n"),
      );
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }
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
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
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
    // Explicit --popup (the in-tmux path) → the observer-backed pane-free dashboard.
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

  it("forwards the resolved explicit config to every renderer path and persists that file", async () => {
    const explicit = await createTempState();
    explicit.config.tui = { widgets: [{ type: "time" }] };
    const explicitPath = await writeConfigToml(explicit.root, explicit.config);
    const inherited = await createTempState();
    inherited.config.tui = { widgets: [{ type: "time", timeFormat: "24h" }] };
    const inheritedPath = await writeConfigToml(inherited.root, inherited.config);
    const entries: string[] = [];
    let persisted = false;
    const spawnRenderer = async ({
      entry,
      env,
    }: {
      entry: string;
      env: Record<string, string>;
    }) => {
      entries.push(entry);
      expect(env.STATION_CONFIG_PATH).toBe(explicitPath);
      if (!persisted) {
        persisted = true;
        const rendererConfigPath = env.STATION_CONFIG_PATH;
        expect(rendererConfigPath).toBe(explicitPath);
        if (rendererConfigPath === undefined) {
          throw new Error("renderer did not receive the resolved config path");
        }
        await setTuiWidgetsInConfig({
          configPath: rendererConfigPath,
          widgets: [{ type: "fleet" }],
        });
      }
      return { status: "exited" as const, code: 0 };
    };
    const launchOptions = {
      env: { STATION_CONFIG_PATH: inheritedPath },
      observerDeps: runningObserverDeps(),
      tuiDeps: { spawnRenderer },
    };

    await runCli(["--config", explicitPath], launchOptions);
    await runCli(["--config", explicitPath, "tui", "--popup"], launchOptions);
    await runCli(["--config", explicitPath, "tui", "--popup", "--persistent"], launchOptions);
    await runCli(["--config", explicitPath, "tui", "--dev-fake-dashboard"], launchOptions);

    expect(entries).toEqual(["station", "dashboard", "dashboard", "dashboard"]);
    expect((await loadConfig({ configPath: explicitPath })).config.tui?.widgets).toEqual([
      { type: "fleet" },
    ]);
    expect((await loadConfig({ configPath: inheritedPath })).config.tui?.widgets).toEqual([
      { type: "time", timeFormat: "24h" },
    ]);
  });

  it("uses compiled self-exec and skips the source workspace installation preflight", async () => {
    const fixture = await createTempState();
    const stationUiInstalled = vi.fn(async () => false);
    const spawnProcess = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { pid: 4321 });
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
      const child = Object.assign(new EventEmitter(), { pid: 4321 });
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
      ["run", "--silent", "--cwd", resolveStationWorkspaceDir(), "dashboard:runtime"],
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
    const records = await readJsonlLog(join(fixture.stateDir, "logs", "cli.jsonl"));
    expect(records[0]?.lifecycle).toMatchObject({
      kind: "renderer.spawn_failed",
      error: { code: "TUI_RENDERER_NOT_INSTALLED" },
    });
  });

  it("preserves the explicit dashboard command shell override", async () => {
    const fixture = await createTempState();
    const stationUiInstalled = vi.fn(async () => false);
    const spawnProcess = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { pid: 4321 });
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
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
        STATION_TUI_PERSISTENT: "1",
        STATION_TUI_POPUP: "1",
      },
    ]);
  });

  it("opens an IPC channel for persistent and transient compiled popup renderers", async () => {
    for (const persistentPopup of [true, false]) {
      const popup = await startPersistentRenderer({ persistentPopup });
      try {
        expect(popup.spawnProcess).toHaveBeenCalledWith(
          "/opt/station/stn",
          ["__dashboard"],
          expect.objectContaining({
            stdio: ["inherit", "inherit", "inherit", "ipc"],
          }),
        );
      } finally {
        await popup.finish();
      }
    }
  });

  it("preserves the persistent source Bun renderer command with IPC", async () => {
    const persistent = await startPersistentRenderer({ source: true });
    const workspaceDir = resolveStationWorkspaceDir();

    try {
      expect(persistent.spawnProcess).toHaveBeenCalledOnce();
      expect(persistent.spawnProcess).toHaveBeenCalledWith(
        "bun",
        ["run", "--silent", "--cwd", workspaceDir, "dashboard:runtime"],
        expect.objectContaining({
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        }),
      );
    } finally {
      await persistent.finish();
    }
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

  it("routes a validated shell request through popup control", async () => {
    const openShell = vi.fn(async () => ({ opened: true }));
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup: async () => ({ dismissed: true }),
        openShell,
        resolveFocusTarget: async () => focusTarget("client-a"),
      },
    });

    try {
      persistent.child.emit("message", {
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "shell-1",
        type: "open-shell",
        cwd: "/repo/station",
      });
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(1));
      expect(openShell).toHaveBeenCalledWith("/repo/station");
      expect(persistent.child.sent[0]).toEqual({
        protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
        requestId: "shell-1",
        type: "shell-opened",
      });
    } finally {
      await persistent.finish();
    }
  });

  it("coalesces concurrent shell requests for one cwd through exact dismissal", async () => {
    let finishOpen: (result: { opened: boolean }) => void = () => {};
    const opening = new Promise<{ opened: boolean }>((resolve) => {
      finishOpen = resolve;
    });
    let exactDismissals = 0;
    const openShell = vi.fn(async () => {
      const result = await opening;
      exactDismissals += 1;
      return result;
    });
    const persistent = await startPersistentRenderer({
      popupControl: {
        dismissPopup: async () => ({ dismissed: true }),
        openShell,
        resolveFocusTarget: async () => focusTarget("client-a"),
      },
    });

    try {
      for (const requestId of ["shell-a", "shell-b"]) {
        persistent.child.emit("message", {
          protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
          requestId,
          type: "open-shell",
          cwd: "/repo/station",
        });
      }
      await vi.waitFor(() => expect(openShell).toHaveBeenCalledTimes(1));
      finishOpen({ opened: true });
      await vi.waitFor(() => expect(persistent.child.sent).toHaveLength(2));

      expect(exactDismissals).toBe(1);
      expect(persistent.child.sent).toEqual([
        {
          protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
          requestId: "shell-a",
          type: "shell-opened",
        },
        {
          protocolVersion: TUI_RENDERER_CONTROL_PROTOCOL_VERSION,
          requestId: "shell-b",
          type: "shell-opened",
        },
      ]);
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
    let finishDismiss: (_result: { dismissed: boolean }) => void = () => {};
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
    let completeResolution: (_target: ReturnType<typeof focusTarget>) => void = () => {};
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
      let completeResolution: (_target: ReturnType<typeof focusTarget>) => void = () => {};
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
        env: { STATION_PANE: "1" },
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
    expect(envs).toEqual([
      {
        STATION_CLIENT_BUILD_VERSION: observerBuildVersion,
        STATION_CONFIG_PATH: configPath,
        STATION_OBSERVER_BUILD_VERSION: observerBuildVersion,
        STATION_OBSERVER_SOCKET_PATH: fixture.socketPath,
      },
    ]);
  });

  it("retains exact renderer signals and never maps a null exit code to success", async () => {
    const fixture = await createTempState();
    const child = Object.assign(new EventEmitter(), { pid: 4321 });
    let childEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = vi.fn((_command, _args, options) => {
      childEnv = options?.env;
      return child as never;
    });

    const resultPromise = runTuiCommand(
      [],
      { config: fixture.config },
      {
        observer: runningObserverDeps(),
        selfExecRuntime: { compiled: true, execPath: "/opt/station/stn" },
        spawnProcess: spawnProcess as never,
      },
    );
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.emit("exit", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({
      status: "exited",
      code: 143,
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(childEnv?.STATION_UI_RUN_ID).toMatch(/^ui_/);
    expect(childEnv?.STATION_UI_CLIENT_KIND).toBeUndefined();
    const records = await readJsonlLog(join(fixture.stateDir, "logs", "cli.jsonl"));
    expect(records.map((record) => record.lifecycle?.kind)).toEqual([
      "renderer.spawned",
      "renderer.exited",
    ]);
    expect(records.at(-1)?.lifecycle).toMatchObject({
      uiRunId: childEnv?.STATION_UI_RUN_ID,
      exitCode: null,
      signal: "SIGTERM",
      rendererPid: 4321,
    });
  });

  it.each([
    "error-first",
    "exit-first",
  ] as const)("records only spawn failure when an unspawned child emits $case", async (eventOrder) => {
    const fixture = await createTempState();
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child as never);
    const resultPromise = runTuiCommand(
      [],
      { config: fixture.config },
      {
        observer: runningObserverDeps(),
        selfExecRuntime: { compiled: true, execPath: "/opt/station/stn" },
        spawnProcess: spawnProcess as never,
      },
    );
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    if (eventOrder === "error-first") {
      child.emit("error", error);
      child.emit("exit", null, null);
    } else {
      child.emit("exit", null, null);
      child.emit("error", error);
    }

    await expect(resultPromise).resolves.toEqual({ status: "exited", code: 1 });
    const records = await readJsonlLog(join(fixture.stateDir, "logs", "cli.jsonl"));
    expect(records.map((record) => record.lifecycle?.kind)).toEqual(["renderer.spawn_failed"]);
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
  readonly pid = 4321;
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
    popupControl?: NonNullable<TuiCommandDeps["popupControl"]>;
    persistentPopup?: boolean;
    sendError?: Error;
    source?: boolean;
  } = {},
) {
  const fixture = await createTempState();
  const child = new FakeRendererChild(options.sendError ?? null);
  const spawnProcess = vi.fn(() => child as never);
  const popupControl =
    options.popupControl ??
    ({
      dismissPopup: async () => ({ dismissed: true }),
      resolveFocusTarget: async () => focusTarget("client-a"),
    } satisfies NonNullable<TuiCommandDeps["popupControl"]>);
  const result = runTuiCommand(
    options.persistentPopup === false ? ["--popup"] : ["--popup", "--persistent"],
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
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

  return {
    child,
    spawnProcess,
    finish: async () => {
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
