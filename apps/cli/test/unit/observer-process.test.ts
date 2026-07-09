import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getObserverStatus, startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createStaleSocketFile } from "../../../../tests/support/sockets";
import { fileExists } from "../../../../tests/support/spool";
import { createTempState } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

const healthyObserver = (pid = 1234) =>
  ({
    schemaVersion: "0.6.0",
    status: "healthy",
    pid,
    startedAt: now,
    version: "0.0.0",
  }) as const;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observerBootLogPath(stateDir: string): string {
  return join(stateDir, "logs", "observer-boot.log");
}

async function writeObserverBootLog(stateDir: string, content: string): Promise<string> {
  await mkdir(join(stateDir, "logs"), { recursive: true });
  const path = observerBootLogPath(stateDir);
  await writeFile(path, content, "utf8");
  return path;
}

function fakeChild(overrides: Partial<ChildProcessLike> = {}): ChildProcessLike {
  return { pid: 1234, unref: () => undefined, ...overrides };
}

function fakeClientFactory(health: () => Promise<unknown>) {
  return () => ({ health }) as never;
}

function unavailableClientFactory(message = "stopped") {
  return fakeClientFactory(async () => {
    throw new Error(message);
  });
}

describe("CLI observer process helpers", () => {
  it("maps stale sockets distinctly from stopped observers", async () => {
    const fixture = await createTempState();
    await createStaleSocketFile(fixture.socketPath);

    await expect(
      getObserverStatus({
        config: fixture.config,
      }),
    ).resolves.toMatchObject({
      status: "stale",
      paths: {
        socketPath: fixture.socketPath,
      },
    });
  });

  it("spawns the observer and waits for health when it is stopped", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let healthAttempts = 0;

    const result = await startObserver(
      {
        config: fixture.config,
        timeoutMs: 200,
      },
      {
        clock: { now: () => new Date(now) },
        spawnObserver: async (): Promise<ChildProcessLike> => {
          spawned = true;
          return { pid: 1234, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => {
              healthAttempts += 1;
              if (healthAttempts === 1) {
                throw new Error("not yet");
              }
              return {
                schemaVersion: "0.6.0",
                status: "healthy",
                pid: 1234,
                startedAt: now,
                version: "0.0.0",
              };
            },
          }) as never,
        sleep: async () => undefined,
      },
    );

    expect(spawned).toBe(true);
    expect(result).toMatchObject({
      status: "running",
      health: {
        status: "healthy",
      },
    });
  });

  it("keeps the spawned child alive when health wins and clears delayed progress", async () => {
    const fixture = await createTempState();
    const neverExits = new Promise<never>(() => undefined);
    const progress: string[] = [];
    let spawned = false;
    let kills = 0;

    vi.useFakeTimers();
    try {
      const result = await startObserver(
        {
          config: fixture.config,
          timeoutMs: 10_000,
          onStartupProgress: (message) => progress.push(message),
        },
        {
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawned = true;
            return fakeChild({
              exited: neverExits,
              kill: () => {
                kills += 1;
                return true;
              },
            });
          },
          clientFactory: fakeClientFactory(async () => {
            if (!spawned) throw new Error("stopped");
            return healthyObserver();
          }),
        },
      );

      expect(result).toMatchObject({ status: "running", health: { pid: 1234 } });
      expect(kills).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(progress).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately when the child exits and includes only a redacted 15-line tail", async () => {
    const fixture = await createTempState();
    const lines = Array.from({ length: 20 }, (_, index) => `boot-line-${index + 1}`);
    lines[19] = "API_TOKEN=super-secret-value";
    const noisyPrefix = "x".repeat(70 * 1024);
    let healthCalls = 0;
    const bootLogPath = await writeObserverBootLog(
      fixture.stateDir,
      `${noisyPrefix}\n${lines.join("\n")}\n`,
    );

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: Promise.resolve({ type: "exit", code: 17, signal: null }),
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          throw new Error("stopped");
        }),
      },
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_EXITED_ON_START",
        message: expect.stringContaining("exit code 17"),
        hint: expect.stringContaining(`Observer boot log: ${bootLogPath}`),
      },
    });
    expect(result.error?.hint).toContain("boot-line-6");
    expect(result.error?.hint).not.toContain("boot-line-5\n");
    expect(result.error?.hint).toContain("API_TOKEN=[REDACTED]");
    expect(result.error?.hint).not.toContain("super-secret-value");
    await expect(readFile(bootLogPath, "utf8")).resolves.toContain("super-secret-value");
    const healthCallsAtExit = healthCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(healthCalls).toBe(healthCallsAtExit);
  });

  it("attaches to a concurrent incumbent when the spawned child exits", async () => {
    const fixture = await createTempState();
    const exited = deferred<{ type: "exit"; code: number; signal: null }>();
    const pendingHealth = new Promise<never>(() => undefined);
    let healthCalls = 0;
    let kills = 0;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: exited.promise,
            kill: () => {
              kills += 1;
              return true;
            },
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          if (healthCalls === 1) throw new Error("initially stopped");
          if (healthCalls === 2) {
            exited.resolve({ type: "exit", code: 1, signal: null });
            return pendingHealth;
          }
          return healthyObserver(9876);
        }),
      },
    );

    expect(result).toMatchObject({ status: "running", health: { pid: 9876 } });
    expect(healthCalls).toBe(3);
    expect(kills).toBe(0);
  });

  it("reports a redacted child spawn error", async () => {
    const fixture = await createTempState();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            pid: undefined,
            exited: Promise.resolve({
              type: "spawn_error",
              error: new Error("spawn failed with API_TOKEN=super-secret-value"),
            }),
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_EXITED_ON_START",
        message: expect.stringContaining("spawn error: spawn failed with API_TOKEN=[REDACTED]"),
        hint: expect.stringContaining(observerBootLogPath(fixture.stateDir)),
      },
    });
    expect(result.error?.message).not.toContain("super-secret-value");
  });

  it("reports the signal when the child is terminated during startup", async () => {
    const fixture = await createTempState();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: Promise.resolve({ type: "exit", code: null, signal: "SIGTERM" }),
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_EXITED_ON_START",
        message: expect.stringContaining("signal SIGTERM"),
      },
    });
  });

  it.each([
    "missing",
    "empty",
    "unreadable",
  ] as const)("still reports the boot log path when the log is %s", async (logState) => {
    const fixture = await createTempState();
    const bootLogPath = observerBootLogPath(fixture.stateDir);
    if (logState === "empty") {
      await writeObserverBootLog(fixture.stateDir, "");
    } else if (logState === "unreadable") {
      await mkdir(bootLogPath, { recursive: true });
    }

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: Promise.resolve({ type: "exit", code: 1, signal: null }),
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    expect(result.error?.hint).toContain(`Observer boot log: ${bootLogPath}`);
    expect(result.error?.hint).not.toContain("Last 15 lines");
  });

  it("removes a stale socket before spawning the observer", async () => {
    const fixture = await createTempState();
    await createStaleSocketFile(fixture.socketPath);
    let spawned = false;

    const result = await startObserver(
      {
        config: fixture.config,
        timeoutMs: 200,
      },
      {
        clock: { now: () => new Date(now) },
        spawnObserver: async (): Promise<ChildProcessLike> => {
          spawned = true;
          return { pid: 1234, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => {
              if (!spawned) {
                throw new Error("not running");
              }
              return {
                schemaVersion: "0.6.0",
                status: "healthy",
                pid: 1234,
                startedAt: now,
                version: "0.0.0",
              };
            },
          }) as never,
        sleep: async () => undefined,
      },
    );

    expect(spawned).toBe(true);
    expect(result.status).toBe("running");
    await expect(fileExists(fixture.socketPath)).resolves.toBe(false);
  });

  it("returns a safe startup error when health does not arrive before timeout", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let killed = false;

    const result = await startObserver(
      {
        config: fixture.config,
        timeoutMs: 20,
      },
      {
        clock: { now: () => new Date(now) },
        spawnObserver: async (): Promise<ChildProcessLike> => {
          spawned = true;
          return {
            pid: 1234,
            unref: () => undefined,
            kill: () => {
              killed = true;
              return true;
            },
          };
        },
        clientFactory: () =>
          ({
            health: async () => {
              throw new Error("raw process failure\n    at internal-frame");
            },
          }) as never,
        sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      },
    );

    expect(spawned).toBe(true);
    expect(killed).toBe(true);
    expect(result).toMatchObject({
      status: "unhealthy",
      error: {
        tag: "ObserverStartupError",
        traceId: expect.stringMatching(/^trc_/),
        hint: expect.stringMatching(/^Run station debug trace trc_/),
      },
    });
    expect(result.error?.message).not.toContain("internal-frame");

    const logs = await readFile(join(fixture.stateDir, "logs", "cli.jsonl"), "utf8");
    const records = logs
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      component: "cli",
      message: "Observer lifecycle failed.",
      traceId: result.error?.traceId,
      attributes: {
        operation: "cli.observer.start",
        error: {
          traceId: result.error?.traceId,
        },
      },
    });
  });

  it("emits delayed startup progress at 1.5s and 5s, then clears its timers", async () => {
    const fixture = await createTempState();
    const spawnedSignal = deferred<void>();
    const progress: string[] = [];
    let spawned = false;
    let ready = false;

    vi.useFakeTimers();
    try {
      const startup = startObserver(
        {
          config: fixture.config,
          timeoutMs: 20_000,
          onStartupProgress: (message) => progress.push(message),
        },
        {
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawned = true;
            spawnedSignal.resolve(undefined);
            return fakeChild();
          },
          clientFactory: fakeClientFactory(async () => {
            if (!spawned || !ready) throw new Error("not ready");
            return healthyObserver();
          }),
        },
      );
      await spawnedSignal.promise;

      await vi.advanceTimersByTimeAsync(1_499);
      expect(progress).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(progress).toEqual(["Starting STATION observer…"]);
      await vi.advanceTimersByTimeAsync(3_499);
      expect(progress).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(progress).toEqual([
        "Starting STATION observer…",
        `Still waiting for STATION observer; boot log: ${observerBootLogPath(fixture.stateDir)}`,
      ]);

      ready = true;
      await vi.advanceTimersByTimeAsync(25);
      await expect(startup).resolves.toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(progress).toHaveLength(2);

      let warmSpawned = false;
      const warmProgress: string[] = [];
      await expect(
        startObserver(
          {
            config: fixture.config,
            onStartupProgress: (message) => warmProgress.push(message),
          },
          {
            spawnObserver: async () => {
              warmSpawned = true;
              return fakeChild({ pid: 5678 });
            },
            clientFactory: fakeClientFactory(async () => healthyObserver()),
          },
        ),
      ).resolves.toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(warmSpawned).toBe(false);
      expect(warmProgress).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "the 10s default", timeoutMs: undefined, beforeMs: 9_999, finalMs: 2 },
    { label: "an explicit override", timeoutMs: 12_000, beforeMs: 10_000, finalMs: 2_001 },
  ])("uses $label and kills only its spawned child on timeout", async (testCase) => {
    const fixture = await createTempState();
    const spawnedSignal = deferred<void>();
    let spawnedKills = 0;
    let settled = false;

    vi.useFakeTimers();
    try {
      const startup = startObserver(
        {
          config: fixture.config,
          ...(testCase.timeoutMs === undefined ? {} : { timeoutMs: testCase.timeoutMs }),
        },
        {
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawnedSignal.resolve(undefined);
            return fakeChild({
              kill: () => {
                spawnedKills += 1;
                return true;
              },
            });
          },
          clientFactory: unavailableClientFactory("still down"),
        },
      );
      void startup.then(() => {
        settled = true;
      });
      await spawnedSignal.promise;

      await vi.advanceTimersByTimeAsync(testCase.beforeMs);
      expect(settled).toBe(false);
      expect(spawnedKills).toBe(0);

      await vi.advanceTimersByTimeAsync(testCase.finalMs);
      await expect(startup).resolves.toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_START_FAILED" },
      });
      expect(spawnedKills).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spawn over a present incompatible observer socket", async () => {
    const fixture = await createTempState();
    const server = await listenUnixSocket({
      socketPath: fixture.socketPath,
      onConnection: () => undefined,
    });
    let spawned = false;

    try {
      const result = await startObserver(
        {
          config: fixture.config,
          timeoutMs: 200,
        },
        {
          clock: { now: () => new Date(now) },
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawned = true;
            return { pid: 1234, unref: () => undefined };
          },
          clientFactory: () =>
            ({
              health: async () => {
                throw {
                  tag: "ProtocolError",
                  code: "PROTOCOL_SCHEMA_MISMATCH",
                  message:
                    "Observer protocol schema mismatch: the observer responded with schema 0.3.0, but this CLI expects schema 0.6.0.",
                  hint: "A different STATION checkout may own the observer socket.",
                };
              },
            }) as never,
          sleep: async () => undefined,
        },
      );

      expect(spawned).toBe(false);
      expect(result).toMatchObject({
        status: "unhealthy",
        error: {
          code: "PROTOCOL_SCHEMA_MISMATCH",
          hint: "A different STATION checkout may own the observer socket.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("does not spawn over a present observer socket when health times out", async () => {
    const fixture = await createTempState();
    const server = await listenUnixSocket({
      socketPath: fixture.socketPath,
      onConnection: () => undefined,
    });
    let spawned = false;

    try {
      const result = await startObserver(
        {
          config: fixture.config,
          timeoutMs: 200,
        },
        {
          clock: { now: () => new Date(now) },
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawned = true;
            return { pid: 1234, unref: () => undefined };
          },
          clientFactory: () =>
            ({
              health: async () => {
                throw {
                  tag: "TimeoutError",
                  code: "PROTOCOL_REQUEST_TIMEOUT",
                  message: "Observer protocol request timed out.",
                };
              },
            }) as never,
          sleep: async () => undefined,
        },
      );

      expect(spawned).toBe(false);
      expect(result).toMatchObject({
        status: "unhealthy",
        error: {
          code: "OBSERVER_HEALTH_TIMEOUT",
          message: expect.stringContaining("health request timed out"),
        },
      });
    } finally {
      await server.close();
    }
  });
});
