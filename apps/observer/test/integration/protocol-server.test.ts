import { access } from "node:fs/promises";
import { join } from "node:path";
import type { StationConfig } from "@station/config";
import { createObserverClient } from "@station/protocol";
import {
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createStaleSocketFile, createTempSocketPath } from "../../../../tests/support/sockets";
import {
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  type PersistenceHealthSource,
  ProviderRegistry,
  probeObserverSocket,
  registerObserverCommandHandlers,
  runObserverMain,
  startObserverServer,
} from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";
const persistenceFailure = {
  tag: "PersistenceError",
  code: "PERSISTENCE_TRANSACTION_FAILED",
  message: "Observer SQLite transaction failed.",
} as const;
const degradedSqliteHealth = {
  path: "/tmp/degraded-observer.sqlite",
  open: true,
  status: "unavailable",
  schemaVersion: 11,
  migrations: [{ version: 11, name: "session_turn_readiness", appliedAt: now }],
  lastCheckedAt: now,
  lastError: persistenceFailure,
} as const;

describe("observer protocol server", () => {
  it("translates absent, stale, and listening socket transport states", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    await expect(probeObserverSocket(socketPath)).resolves.toBe("absent");

    await createStaleSocketFile(socketPath);
    await expect(probeObserverSocket(socketPath)).resolves.toBe("stale");

    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
      drainOnStart: false,
    });
    try {
      await expect(probeObserverSocket(socketPath)).resolves.toBe("listening");
      const stateDir = join(dir, "losing-state");
      const providerRegistryFactory = vi.fn(() => {
        throw new Error("providers must not be constructed for a listening socket");
      });
      await expect(
        runObserverMain(
          ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "100"],
          { providerRegistryFactory },
        ),
      ).resolves.toBe(0);
      expect(providerRegistryFactory).not.toHaveBeenCalled();
      await expect(access(join(stateDir, "observer.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(`${socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      fixture.sqlite.close();
    }
  });

  it("serves health, diagnostics, command dispatch, command get, and reconcile", async () => {
    const { socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
      drainOnStart: false,
    });
    const client = createObserverClient({ socketPath, requestId: ids("req") });

    await expect(client.health()).resolves.toMatchObject({
      status: "healthy",
      socketPath,
      sqlite: degradedSqliteHealth,
    });
    await expect(client.collectDiagnostics({ includeLogs: false })).resolves.toMatchObject({
      observerHealth: {
        sqlite: degradedSqliteHealth,
      },
    });
    await expect(client.runDoctor()).resolves.toMatchObject({
      status: "degraded",
      observer: {
        sqlite: degradedSqliteHealth,
      },
      sqlite: degradedSqliteHealth,
      checks: expect.arrayContaining([
        {
          name: "sqlite",
          status: "warn",
          message: "SQLite is unavailable.",
          error: persistenceFailure,
        },
      ]),
    });
    await expect(client.reconcile("protocol-server-test")).resolves.toMatchObject({
      reason: "protocol-server-test",
      snapshot: {
        counts: {
          projects: 1,
          worktrees: 1,
        },
      },
    });

    const receipt = await client.dispatch({
      type: "observer.reconcile",
      payload: { reason: "command" },
    });
    await fixture.queue.drain();

    await expect(client.getCommand(receipt.commandId)).resolves.toMatchObject({
      id: "cmd_1",
      status: "succeeded",
    });

    await server.close();
    fixture.sqlite.close();
  });
});

function createObserverFixture(socketPath: string) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const persistence = createSqliteObserverPersistence({
    sqlite,
    clock,
    idFactory: observerIds(),
  });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({
    persistence,
    clock,
    idFactory: observerIds(),
    eventBus,
  });
  const providers = new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [createFakeWorktree({ id: "wt_web_main", projectId: "web", now })],
    }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses: [new FakeHarnessProvider({ now })],
  });
  const core = createObserverCore({
    config,
    providers,
    persistence,
    clock,
  });
  const persistenceHealth: PersistenceHealthSource = {
    health: () => degradedSqliteHealth,
  };
  const api = createObserverApi({
    core,
    persistence,
    persistenceHealth,
    commandQueue: queue,
    eventBus,
    clock,
    socketPath,
  });
  registerObserverCommandHandlers({
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
  });
  return { api, queue, sqlite, clock };
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "fake-harness",
        terminal: "fake-terminal",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
  ],
};

function observerIds() {
  let command = 0;
  let event = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

function ids(prefix: string): () => string {
  let id = 0;
  return () => `${prefix}_${++id}`;
}
