import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import type { ObserverHealth, SafeError } from "@station/contracts";
import { stationObserverBuildVersion } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";
const higherBuildVersion = `2.0.0+station.${"a".repeat(64)}`;
const lowerBuildVersion = `1.0.0+station.${"b".repeat(64)}`;

const healthyObserver = (pid = 1234, version = stationObserverBuildVersion()) =>
  ({
    schemaVersion: "0.11.0",
    status: "healthy",
    pid,
    startedAt: now,
    version,
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

type ObserverStatusResult = Awaited<ReturnType<typeof startObserver>>;

function statusError(result: ObserverStatusResult): SafeError | undefined {
  return result.status === "running" ? undefined : result.error;
}

function statusHealth(result: ObserverStatusResult): ObserverHealth | undefined {
  return result.status === "running" ? result.health : undefined;
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
      expect(statusError(result)?.hint).toContain("This attempt's last 15 lines (redacted):");
      expect(statusError(result)?.hint).toContain("boot-line-6");
      expect(statusError(result)?.hint).not.toContain("boot-line-5\n");
      expect(statusError(result)?.hint).toContain("API_TOKEN=[REDACTED]");
      expect(statusError(result)?.hint).not.toContain("super-secret-value");
      expect(statusError(result)?.hint).not.toContain("winning-attempt");
      await expect(readFile(bootLogPath, "utf8")).resolves.toBe("winning-attempt\n");
      expect(bootLogDisposals).toBe(1);
      const healthCallsAtExit = healthCalls;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthCalls).toBe(healthCallsAtExit);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels its spawned child after attaching to a concurrent incumbent", async () => {
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
    expect(kills).toBe(1);
    expect(exitWaitDisposals).toBe(1);
  });

  it("cancels its spawned child when compatible incumbent health omits pid", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let kills = 0;
    const { pid: _pid, ...healthWithoutPid } = healthyObserver();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async () => {
          spawned = true;
          return fakeChild({
            pid: 5678,
            kill: () => {
              kills += 1;
              return true;
            },
          });
        },
        clientFactory: fakeClientFactory(async () => {
          if (!spawned) throw new Error("observer offline");
          return healthWithoutPid;
        }),
      },
    );

    expect(result).toMatchObject({
      status: "running",
      health: { version: stationObserverBuildVersion() },
    });
    expect(statusHealth(result)?.pid).toBeUndefined();
    expect(kills).toBe(1);
  });

  it("keeps waiting through lower-build health until the spawned build owns the socket", async () => {
    const fixture = await createTempState();
    let healthCalls = 0;
    let kills = 0;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        buildVersion: higherBuildVersion,
        spawnObserver: async () =>
          fakeChild({
            pid: 5678,
            kill: () => {
              kills += 1;
              return true;
            },
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          return healthCalls < 3
            ? healthyObserver(1234, "1.0.0")
            : healthyObserver(5678, higherBuildVersion);
        }),
      },
    );

    expect(result).toMatchObject({
      status: "running",
      health: { pid: 5678, version: higherBuildVersion },
    });
    expect(healthCalls).toBe(3);
    expect(kills).toBe(0);
  });

  it.each([
    {
      label: "exit code",
      exit: { type: "exit" as const, code: 17, signal: null },
      expected: "Replacement child: exit code 17",
    },
    {
      label: "signal",
      exit: { type: "exit" as const, code: null, signal: "SIGTERM" as const },
      expected: "Replacement child: signal SIGTERM",
    },
    {
      label: "spawn error",
      exit: {
        type: "spawn_error" as const,
        error: new Error("launch failed with API_TOKEN=super-secret-value"),
      },
      expected: "Replacement child: spawn error: launch failed with API_TOKEN=[REDACTED]",
    },
    {
      label: "unknown status",
      exit: { type: "exit" as const, code: null, signal: null },
      expected: "Replacement child: unknown exit status",
    },
  ])("retains a replacement child's $label under handoff refusal", async ({ exit, expected }) => {
    const fixture = await createTempState();
    let healthCalls = 0;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 2_000 },
      {
        buildVersion: higherBuildVersion,
        spawnObserver: async () =>
          fakeChild({
            pid: 5678,
            exited: Promise.resolve(exit),
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          return healthyObserver(1234, lowerBuildVersion);
        }),
      },
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_HANDOFF_REFUSED", traceId: expect.any(String) },
    });
    expect(statusError(result)?.hint).toContain(expected);
    expect(statusError(result)?.hint).toContain(
      "Health convergence: OBSERVER_INCUMBENT_HEALTH_TIMEOUT after 1000 ms",
    );
    expect(statusError(result)?.hint).toContain("Boot-log tail unavailable");
    expect(statusError(result)?.hint).toContain("1.0.0 (build bbbbbbbbbbbb)");
    expect(statusError(result)?.hint).toContain("2.0.0 (build aaaaaaaaaaaa)");
    expect(statusError(result)?.hint).toContain(
      `station debug trace ${statusError(result)?.traceId}`,
    );
    expect(statusError(result)?.hint).not.toContain("super-secret-value");
    expect(healthCalls).toBeGreaterThan(1);
  });

  it.each([
    { delayMs: 999, expectedStatus: "running", expectedCode: undefined },
    {
      delayMs: 1_001,
      expectedStatus: "unhealthy",
      expectedCode: "OBSERVER_HANDOFF_REFUSED",
    },
  ])("keeps the one-second convergence boundary at $delayMs ms", async ({
    delayMs,
    expectedStatus,
    expectedCode,
  }) => {
    const fixture = await createTempState();
    const replacementHealthObserved = deferred<void>();
    const childExited = deferred<{ type: "exit"; code: number; signal: null }>();
    const compatibleHealth = deferred<ReturnType<typeof healthyObserver>>();
    let healthCalls = 0;

    vi.useFakeTimers();
    try {
      const startup = startObserver(
        { config: fixture.config, timeoutMs: 5_000 },
        {
          buildVersion: higherBuildVersion,
          spawnObserver: async () =>
            fakeChild({
              pid: 5678,
              exited: childExited.promise,
            }),
          clientFactory: fakeClientFactory(async () => {
            healthCalls += 1;
            if (healthCalls <= 2) {
              if (healthCalls === 2) replacementHealthObserved.resolve(undefined);
              return healthyObserver(1234, lowerBuildVersion);
            }
            return compatibleHealth.promise;
          }),
        },
      );
      await replacementHealthObserved.promise;
      await vi.advanceTimersByTimeAsync(0);
      childExited.resolve({ type: "exit", code: 0, signal: null });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(delayMs);
      compatibleHealth.resolve(healthyObserver(9876, higherBuildVersion));
      await vi.advanceTimersByTimeAsync(0);
      const result = await startup;

      expect(result.status).toBe(expectedStatus);
      expect(statusError(result)?.code).toBe(expectedCode);
      if (delayMs === 1_001) {
        expect(statusError(result)?.hint).toContain(
          "Health convergence: OBSERVER_INCUMBENT_HEALTH_TIMEOUT after 1000 ms",
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a normalized health rejection and the child-owned boot tail", async () => {
    const fixture = await createTempState();
    let healthCalls = 0;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        buildVersion: higherBuildVersion,
        spawnObserver: async () =>
          fakeChild({
            exited: Promise.resolve({ type: "exit", code: 1, signal: null }),
            readBootLogTail: async () => "startup failed with API_TOKEN=super-secret-value",
          }),
        clientFactory: fakeClientFactory(async () => {
          healthCalls += 1;
          return healthCalls <= 2
            ? healthyObserver(1234, lowerBuildVersion)
            : healthyObserver(9876, `2.0.0+station.${"c".repeat(64)}`);
        }),
      },
    );

    expect(statusError(result)?.code).toBe("OBSERVER_HANDOFF_REFUSED");
    expect(statusError(result)?.hint).toContain("Health convergence: OBSERVER_HANDOFF_REFUSED");
    expect(statusError(result)?.hint).toContain("This attempt's last 15 lines (redacted):");
    expect(statusError(result)?.hint).toContain("API_TOKEN=[REDACTED]");
    expect(statusError(result)?.hint).not.toContain("super-secret-value");
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
    expect(statusError(result)?.message).not.toContain("super-secret-value");
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

    expect(statusError(result)?.hint).toContain(`Observer boot log: ${bootLogPath}`);
    expect(statusError(result)?.hint).toContain("Boot-log tail unavailable");
    expect(statusError(result)?.hint).not.toContain("Last 15 lines");
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

  it("includes the redacted boot-log tail in a startup timeout hint", async () => {
    const fixture = await createTempState();
    const readBootLogTail = vi.fn(async () => "boot crashed after API_TOKEN=super-secret-value");
    let killed = false;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 60 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: new Promise<never>(() => undefined),
            readBootLogTail,
            kill: () => {
              killed = true;
              return true;
            },
          }),
        clientFactory: unavailableClientFactory(),
      },
    );

    expect(killed).toBe(true);
    expect(statusError(result)?.code).toBe("OBSERVER_START_FAILED");
    expect(statusError(result)?.hint).toMatch(/^Run station debug trace trc_/);
    expect(readBootLogTail).toHaveBeenCalled();
    expect(statusError(result)?.hint).toContain(
      `Latest observer boot log: ${observerBootLogPath(fixture.stateDir)}`,
    );
    expect(statusError(result)?.hint).toContain("boot crashed after API_TOKEN=[REDACTED]");
    expect(statusError(result)?.hint).not.toContain("super-secret-value");
  });

  it("includes the redacted one-line spawn failure reason in a flattened startup error hint", async () => {
    const fixture = await createTempState();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 5_000 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> => {
          throw new Error(
            "spawn aborted: listener failed with API_TOKEN=super-secret-value\n    at internal-frame",
          );
        },
        clientFactory: unavailableClientFactory(),
      },
    );

    expect(statusError(result)?.code).toBe("OBSERVER_START_FAILED");
    expect(statusError(result)?.message).toBe("Observer startup failed.");
    expect(statusError(result)?.hint).toMatch(/^Run station debug trace trc_/);
    expect(statusError(result)?.hint).toContain(
      "Startup failure: spawn aborted: listener failed with API_TOKEN=[REDACTED]",
    );
    expect(statusError(result)?.hint).toContain(
      `Observer boot log: ${observerBootLogPath(fixture.stateDir)}`,
    );
    expect(statusError(result)?.hint).not.toContain("super-secret-value");
    expect(statusError(result)?.hint).not.toContain("internal-frame");
  });

  it("leaves a SafeError-shaped health failure reason out of the enriched hint", async () => {
    const fixture = await createTempState();

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 60 },
      {
        spawnObserver: async (): Promise<ChildProcessLike> =>
          fakeChild({
            exited: new Promise<never>(() => undefined),
            kill: () => true,
          }),
        clientFactory: fakeClientFactory(async () => {
          throw new Error("raw process failure\n    at internal-frame");
        }),
      },
    );

    expect(statusError(result)?.code).toBe("OBSERVER_START_FAILED");
    expect(statusError(result)?.hint).toMatch(/^Run station debug trace trc_/);
    expect(statusError(result)?.hint).not.toContain("Startup failure:");
    expect(JSON.stringify(statusError(result))).not.toContain("internal-frame");
  });
});
