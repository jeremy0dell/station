import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getObserverStatus, restartObserver, startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createStaleSocketFile } from "../../../../../tests/support/sockets";
import { fileExists } from "../../../../../tests/support/spool";
import { createTempState } from "../../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

describe("CLI observer process lifecycle", () => {
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
    let spawnInput: unknown;

    const result = await startObserver(
      {
        config: fixture.config,
        timeoutMs: 200,
      },
      {
        buildVersion: "0.0.0",
        clock: { now: () => new Date(now) },
        spawnObserver: async (input): Promise<ChildProcessLike> => {
          spawnInput = input;
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
                schemaVersion: "0.8.0",
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
    expect(spawnInput).toEqual({
      paths: expect.objectContaining({ socketPath: fixture.socketPath }),
    });
    expect(result).toMatchObject({
      status: "running",
      health: {
        status: "healthy",
      },
    });
  });

  it("leaves a stale socket for the spawned observer to reclaim", async () => {
    const fixture = await createTempState();
    await createStaleSocketFile(fixture.socketPath);
    let spawned = false;
    let staleSocketPresentAtSpawn = false;

    const result = await startObserver(
      {
        config: fixture.config,
        timeoutMs: 200,
      },
      {
        buildVersion: "0.0.0",
        clock: { now: () => new Date(now) },
        spawnObserver: async (): Promise<ChildProcessLike> => {
          staleSocketPresentAtSpawn = await fileExists(fixture.socketPath);
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
                schemaVersion: "0.8.0",
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
    expect(staleSocketPresentAtSpawn).toBe(true);
    expect(result.status).toBe("running");
    await expect(fileExists(fixture.socketPath)).resolves.toBe(true);
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
        buildVersion: "0.0.0",
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
                    "Observer protocol schema mismatch: the observer responded with schema 0.3.0, but this CLI expects schema 0.8.0.",
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

  it("attaches to an exact or newer healthy incumbent without spawning", async () => {
    const fixture = await createTempState();
    let spawned = false;

    for (const version of ["1.2.3", "2.0.0"]) {
      const result = await startObserver(
        { config: fixture.config },
        {
          buildVersion: "1.2.3",
          spawnObserver: async () => {
            spawned = true;
            return { pid: 5678, unref: () => undefined };
          },
          clientFactory: () =>
            ({
              health: async () => ({
                schemaVersion: "0.8.0",
                status: "healthy",
                pid: 1234,
                startedAt: now,
                version,
                socketPath: fixture.socketPath,
              }),
            }) as never,
        },
      );

      expect(result).toMatchObject({ status: "running", health: { version, pid: 1234 } });
    }
    expect(spawned).toBe(false);
  });

  it("refuses to restart a newer incumbent from a lower build", async () => {
    const fixture = await createTempState();
    let stops = 0;
    let spawns = 0;
    const result = await restartObserver(
      { config: fixture.config },
      {
        buildVersion: "1.0.0",
        spawnObserver: async () => {
          spawns += 1;
          return { pid: 5678, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => ({
              schemaVersion: "0.8.0",
              status: "healthy",
              pid: 1234,
              startedAt: now,
              version: "2.0.0",
              socketPath: fixture.socketPath,
            }),
            stop: async () => {
              stops += 1;
              return { schemaVersion: "0.8.0", stopped: true, at: now };
            },
          }) as never,
      },
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      error: {
        code: "OBSERVER_HANDOFF_REFUSED",
        hint: expect.stringContaining("cannot restart a newer Observer"),
      },
    });
    expect(stops).toBe(0);
    expect(spawns).toBe(0);
  });

  it("restarts an exact build through the explicit stop path", async () => {
    const fixture = await createTempState();
    let running = true;
    let stops = 0;
    let spawns = 0;
    const result = await restartObserver(
      { config: fixture.config, timeoutMs: 500 },
      {
        buildVersion: "1.0.0",
        spawnObserver: async () => {
          spawns += 1;
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
                version: "1.0.0",
                socketPath: fixture.socketPath,
              };
            },
            stop: async () => {
              stops += 1;
              running = false;
              return { schemaVersion: "0.8.0", stopped: true, at: now };
            },
          }) as never,
      },
    );

    expect(result).toMatchObject({ status: "running", health: { version: "1.0.0" } });
    expect(stops).toBe(1);
    expect(spawns).toBe(1);
  });

  it("routes a higher-build restart through child handoff without a parent stop", async () => {
    const fixture = await createTempState();
    let version = "1.0.0";
    let pid = 1234;
    let stops = 0;
    let spawns = 0;
    const result = await restartObserver(
      { config: fixture.config, timeoutMs: 500 },
      {
        buildVersion: "2.0.0",
        spawnObserver: async () => {
          spawns += 1;
          version = "2.0.0";
          pid = 5678;
          return { pid, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => ({
              schemaVersion: "0.8.0",
              status: "healthy",
              pid,
              startedAt: now,
              version,
              socketPath: fixture.socketPath,
            }),
            stop: async () => {
              stops += 1;
              return { schemaVersion: "0.8.0", stopped: true, at: now };
            },
          }) as never,
      },
    );

    expect(result).toMatchObject({ status: "running", health: { pid: 5678, version: "2.0.0" } });
    expect(stops).toBe(0);
    expect(spawns).toBe(1);
  });

  it("spawns a higher build and ignores the lower incumbent until its child is healthy", async () => {
    const fixture = await createTempState();
    let spawned = false;
    let healthAttempts = 0;

    const result = await startObserver(
      { config: fixture.config, timeoutMs: 500 },
      {
        buildVersion: "2.0.0",
        spawnObserver: async () => {
          spawned = true;
          return { pid: 5678, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => {
              healthAttempts += 1;
              if (!spawned || healthAttempts < 3) {
                return {
                  schemaVersion: "0.8.0",
                  status: "healthy",
                  pid: 1234,
                  startedAt: now,
                  version: "1.0.0",
                  socketPath: fixture.socketPath,
                };
              }
              return {
                schemaVersion: "0.8.0",
                status: "healthy",
                pid: 5678,
                startedAt: now,
                version: "2.0.0",
                socketPath: fixture.socketPath,
              };
            },
          }) as never,
      },
    );

    expect(spawned).toBe(true);
    expect(healthAttempts).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ status: "running", health: { version: "2.0.0", pid: 5678 } });
  });

  it.each([
    ["missing version", { pid: 1234, startedAt: now, socketPath: "/tmp/observer.sock" }],
    ["missing pid", { version: "1.0.0", startedAt: now, socketPath: "/tmp/observer.sock" }],
    ["missing start time", { version: "1.0.0", pid: 1234, socketPath: "/tmp/observer.sock" }],
    [
      "invalid version",
      { version: "not-semver", pid: 1234, startedAt: now, socketPath: "/tmp/observer.sock" },
    ],
  ])("refuses legacy incumbent health with %s without spawning", async (_label, identity) => {
    const fixture = await createTempState();
    let spawned = false;
    const result = await startObserver(
      { config: fixture.config },
      {
        buildVersion: "2.0.0",
        spawnObserver: async () => {
          spawned = true;
          return { pid: 5678, unref: () => undefined };
        },
        clientFactory: () =>
          ({
            health: async () => ({
              schemaVersion: "0.8.0",
              status: "healthy",
              ...identity,
            }),
          }) as never,
      },
    );

    expect(spawned).toBe(false);
    expect(result).toMatchObject({
      status: "unhealthy",
      error: { code: "OBSERVER_HANDOFF_REFUSED" },
    });
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
