import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../../tests/support/temp-projects";

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

describe("CLI observer process startup", () => {
  it("keeps the spawned child alive when health wins and clears delayed progress", async () => {
    const fixture = await createTempState();
    const neverExits = new Promise<never>(() => undefined);
    const progress: string[] = [];
    let spawned = false;
    let kills = 0;
    let bootLogDisposals = 0;

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
              disposeBootLog: async () => {
                bootLogDisposals += 1;
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
      expect(bootLogDisposals).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(progress).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits briefly for an incumbent, then reports the failed child's redacted tail", async () => {
    const fixture = await createTempState();
    const lines = Array.from({ length: 20 }, (_, index) => `boot-line-${index + 1}`);
    lines[19] = "API_TOKEN=super-secret-value";
    const attemptTail = lines.slice(-15).join("\n");
    let healthCalls = 0;
    let bootLogDisposals = 0;
    let settled = false;
    const spawnedSignal = deferred<void>();
    const bootLogPath = await writeObserverBootLog(fixture.stateDir, "winning-attempt\n");

    vi.useFakeTimers();
    try {
      const startup = startObserver(
        { config: fixture.config, timeoutMs: 5_000 },
        {
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawnedSignal.resolve(undefined);
            return fakeChild({
              exited: Promise.resolve({ type: "exit", code: 17, signal: null }),
              readBootLogTail: async () => attemptTail,
              disposeBootLog: async () => {
                bootLogDisposals += 1;
              },
            });
          },
          clientFactory: fakeClientFactory(async () => {
            healthCalls += 1;
            throw new Error("stopped");
          }),
        },
      );
      void startup.then(() => {
        settled = true;
      });
      await spawnedSignal.promise;
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const result = await startup;

      expect(result).toMatchObject({
        status: "unhealthy",
        error: {
          code: "OBSERVER_EXITED_ON_START",
          message: expect.stringContaining("exit code 17"),
          hint: expect.stringContaining(`Latest observer boot log: ${bootLogPath}`),
        },
      });
      expect(result.error?.hint).toContain("This attempt's last 15 lines (redacted):");
      expect(result.error?.hint).toContain("boot-line-6");
      expect(result.error?.hint).not.toContain("boot-line-5\n");
      expect(result.error?.hint).toContain("API_TOKEN=[REDACTED]");
      expect(result.error?.hint).not.toContain("super-secret-value");
      expect(result.error?.hint).not.toContain("winning-attempt");
      await expect(readFile(bootLogPath, "utf8")).resolves.toBe("winning-attempt\n");
      expect(bootLogDisposals).toBe(1);
      const healthCallsAtExit = healthCalls;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthCalls).toBe(healthCallsAtExit);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches to a concurrent incumbent when the spawned child exits", async () => {
    const fixture = await createTempState();
    const exited = deferred<{ type: "exit"; code: number; signal: null }>();
    let healthCalls = 0;
    let kills = 0;
    let exitWaitDisposals = 0;

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
            disposeExitWait: () => {
              exitWaitDisposals += 1;
            },
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          if (healthCalls === 1) throw new Error("initially stopped");
          if (healthCalls === 2) {
            exited.resolve({ type: "exit", code: 1, signal: null });
            throw new Error("winner still booting");
          }
          if (healthCalls === 3) throw new Error("winner not ready yet");
          return healthyObserver(9876);
        }),
      },
    );

    expect(result).toMatchObject({ status: "running", health: { pid: 9876 } });
    expect(healthCalls).toBe(4);
    expect(kills).toBe(0);
    expect(exitWaitDisposals).toBe(1);
  });

  it("lets the outer startup timeout preempt incumbent convergence", async () => {
    const fixture = await createTempState();
    const spawnedSignal = deferred<void>();
    let healthCalls = 0;
    let kills = 0;
    let settled = false;

    vi.useFakeTimers();
    try {
      const startup = startObserver(
        { config: fixture.config, timeoutMs: 100 },
        {
          spawnObserver: async (): Promise<ChildProcessLike> => {
            spawnedSignal.resolve(undefined);
            return fakeChild({
              exited: Promise.resolve({ type: "exit", code: 1, signal: null }),
              kill: () => {
                kills += 1;
                return true;
              },
            });
          },
          clientFactory: fakeClientFactory(async () => {
            healthCalls += 1;
            throw new Error("still down");
          }),
        },
      );
      void startup.then(() => {
        settled = true;
      });
      await spawnedSignal.promise;

      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(startup).resolves.toMatchObject({
        status: "unhealthy",
        error: { code: "OBSERVER_START_FAILED" },
      });
      expect(kills).toBe(1);
      const healthCallsAtTimeout = healthCalls;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthCalls).toBe(healthCallsAtTimeout);
    } finally {
      vi.useRealTimers();
    }
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
});
