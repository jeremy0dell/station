import { access, chmod } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { createObserverClient } from "@station/protocol";
import {
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createRealStaleSocket, createTempSocketPath } from "../../../../tests/support/sockets";
import {
  acquireObserverBootClaim,
  createCommandQueue,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createObserverLifecycleClient,
  createSqliteObserverPersistence,
  openObserverSqlite,
  type PersistenceHealthSource,
  ProviderRegistry,
  probeObserverSocket,
  registerObserverCommandHandlers,
  runObserverMain,
  startObserverServer,
} from "../../src/internal";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";

const now = "2026-05-20T12:00:00.000Z";
const observerDisplayVersion = "0.0.0";
const observerBuildVersion = `${observerDisplayVersion}+station.${"a".repeat(64)}`;
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
    await expect(probeObserverSocket(socketPath)).resolves.toEqual({ status: "absent" });

    await createRealStaleSocket(socketPath);
    await expect(probeObserverSocket(socketPath)).resolves.toMatchObject({ status: "stale" });

    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    try {
      await expect(probeObserverSocket(socketPath)).resolves.toMatchObject({
        status: "listening",
      });
      const stateDir = join(dir, "losing-state");
      const providerRegistryFactory = vi.fn(() => {
        throw new Error("providers must not be constructed for a listening socket");
      });
      const incumbentLifecycle = {
        health: async () => {
          const contender = await acquireObserverBootClaim({ socketPath, timeoutMs: 25 });
          expect(contender).toMatchObject({ status: "contended" });
          return fixture.api.health();
        },
        stop: fixture.api.stop,
        socketListening: async () => true,
      };
      await expect(
        runObserverMain(
          ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "1000"],
          { providerRegistryFactory, buildVersion: observerBuildVersion, incumbentLifecycle },
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

  it("refuses inaccessible ownership before providers or runtime state are created", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    const stateDir = join(dir, "refused-state");
    const providerRegistryFactory = vi.fn(() => {
      throw new Error("providers must not be constructed for inaccessible ownership");
    });
    try {
      await chmod(socketPath, 0o000);
      await expect(probeObserverSocket(socketPath)).resolves.toMatchObject({
        status: "inaccessible",
        error: { code: "OBSERVER_SOCKET_INACCESSIBLE" },
      });
      const lifecycle = createObserverLifecycleClient({ timeoutMs: 100 });
      await expect(lifecycle.socketListening(socketPath, { timeoutMs: 100 })).rejects.toMatchObject(
        {
          code: "OBSERVER_SOCKET_INACCESSIBLE",
        },
      );
      await expect(
        runObserverMain(
          ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "1000"],
          { providerRegistryFactory, buildVersion: observerBuildVersion },
        ),
      ).rejects.toMatchObject({ code: "OBSERVER_SOCKET_INACCESSIBLE" });
      expect(providerRegistryFactory).not.toHaveBeenCalled();
      await expect(access(join(stateDir, "observer.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(`${socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(socketPath, 0o600);
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
    });
    const client = createObserverClient({ socketPath, requestId: ids("req") });
    const lifecycle = createObserverLifecycleClient({ timeoutMs: 1000 });

    await expect(lifecycle.socketListening(socketPath, { timeoutMs: 1000 })).resolves.toBe(true);
    const lifecycleHealth = await lifecycle.health(socketPath, { timeoutMs: 1000 });
    expect(lifecycleHealth).toMatchObject({
      status: "healthy",
      socketPath,
    });
    if (
      lifecycleHealth.pid === undefined ||
      lifecycleHealth.startedAt === undefined ||
      lifecycleHealth.version === undefined ||
      lifecycleHealth.socketPath === undefined
    ) {
      throw new Error("Expected lifecycle health to include Observer process identity.");
    }
    const expectedObserver = {
      pid: lifecycleHealth.pid,
      startedAt: lifecycleHealth.startedAt,
      version: lifecycleHealth.version,
      socketPath: lifecycleHealth.socketPath,
    };
    await expect(client.health()).resolves.toMatchObject({
      status: "healthy",
      socketPath,
      version: observerBuildVersion,
      sqlite: degradedSqliteHealth,
    });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      observer: { version: observerDisplayVersion },
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
    await expect(
      lifecycle.stop(socketPath, { timeoutMs: 1000, expectedObserver }),
    ).resolves.toMatchObject({
      stopped: true,
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
    version: observerDisplayVersion,
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
    observerBuildVersion,
  });
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
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
  workspace: DEFAULT_WORKSPACE_CONFIG,
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
