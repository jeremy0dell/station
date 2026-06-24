import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getObserverStatus, startObserver } from "@station/cli";
import type { ChildProcessLike } from "@station/cli/internal";
import { listenUnixSocket } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createStaleSocketFile } from "../../../../tests/support/sockets";
import { fileExists } from "../../../../tests/support/spool";
import { createTempState } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

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
                schemaVersion: "0.5.0",
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
                schemaVersion: "0.5.0",
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
                    "Observer protocol schema mismatch: the observer responded with schema 0.3.0, but this CLI expects schema 0.5.0.",
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
