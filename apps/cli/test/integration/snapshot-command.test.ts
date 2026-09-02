import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConfig } from "@station/config";
import { type StationSnapshot, StationSnapshotSchema } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { loadObserverSnapshot, runSnapshotCommand } from "../../src/commands/snapshot.js";

const now = "2026-08-25T12:00:00.000Z";
const observerBuildVersion = `0.0.0-local+station.${"a".repeat(64)}`;

describe("snapshot command", () => {
  it("rejects raw argv before observer startup", async () => {
    const spawnObserver = vi.fn();

    await expect(
      runSnapshotCommand(["--not-a-snapshot-option"], {}, { spawnObserver }),
    ).rejects.toThrow("Unknown snapshot option");
    expect(spawnObserver).not.toHaveBeenCalled();
  });

  it("starts a missing Observer by default and loads exactly one snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-snapshot-start-"));
    const config = configForRoot(root);
    const snapshot = snapshotFixture();
    let spawned = false;
    const spawnObserver = vi.fn(async () => {
      spawned = true;
      return { pid: 1234, unref: () => undefined };
    });
    const getSnapshot = vi.fn(async () => snapshot);

    try {
      await expect(
        runSnapshotCommand(
          ["--json"],
          { config, timeoutMs: 100 },
          {
            buildVersion: observerBuildVersion,
            spawnObserver,
            clientFactory: (socketPath) =>
              ({
                health: async () => {
                  if (!spawned) throw new Error("not running");
                  return runningHealth(socketPath);
                },
                getSnapshot,
              }) as never,
            sleep: async () => undefined,
          },
        ),
      ).resolves.toEqual(snapshot);
      expect(spawnObserver).toHaveBeenCalledTimes(1);
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expect(getSnapshot).toHaveBeenCalledWith(undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes typed includeDebug to exactly one snapshot query", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-snapshot-typed-"));
    const config = configForRoot(root);
    const snapshot = snapshotFixture({ includeDebug: true });
    const getSnapshot = vi.fn(async () => snapshot);

    try {
      await expect(
        loadObserverSnapshot(
          { config, includeDebug: true, timeoutMs: 100 },
          runningDeps(getSnapshot),
        ),
      ).resolves.toEqual(snapshot);
      expect(getSnapshot).toHaveBeenCalledTimes(1);
      expect(getSnapshot).toHaveBeenCalledWith({ includeDebug: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not spawn an Observer when --require-running finds no runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-snapshot-require-running-"));
    const spawnObserver = vi.fn();
    const config = configForRoot(root);

    try {
      await expect(
        runSnapshotCommand(
          ["--json", "--require-running"],
          { config, timeoutMs: 50 },
          {
            spawnObserver,
            clientFactory: () =>
              ({
                health: async () => {
                  throw new Error("not running");
                },
              }) as never,
          },
        ),
      ).rejects.toMatchObject({ error: { code: "OBSERVER_NOT_RUNNING" } });
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function configForRoot(root: string) {
  return {
    ...emptyConfig(),
    observer: {
      stateDir: join(root, "state"),
      socketPath: join(root, "observer.sock"),
    },
  };
}

function runningDeps(getSnapshot: () => Promise<StationSnapshot>) {
  return {
    buildVersion: observerBuildVersion,
    clientFactory: (socketPath: string) =>
      ({
        health: async () => runningHealth(socketPath),
        getSnapshot,
      }) as never,
    sleep: async () => undefined,
  };
}

function runningHealth(socketPath: string) {
  return {
    schemaVersion: "0.13.0" as const,
    status: "healthy" as const,
    pid: 1234,
    startedAt: now,
    version: observerBuildVersion,
    socketPath,
  };
}

function snapshotFixture(options?: { includeDebug?: boolean }): StationSnapshot {
  return StationSnapshotSchema.parse({
    schemaVersion: "0.13.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
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
    ...(options?.includeDebug === true
      ? {
          debug: {
            terminal: {
              reconciledAt: now,
              providerReads: [],
              targets: [],
            },
          },
        }
      : {}),
  });
}
