import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { componentLogPath } from "@station/observability";
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
import {
  createObserverProcessIdentity,
  readObserverProcessIdentity,
} from "../../src/runtime/observerPidfile.js";
import type { ObserverDuplicateProcessEvidenceSource } from "../../src/runtime/observerReap.js";
import { readSocketIdentity } from "../../src/runtime/socketOwnership.js";
import { FakeDiagnosticEvidenceSource } from "../support/diagnosticEvidenceSources.js";
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

  it("captures canonical runtime paths in the local diagnostic adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-runtime-diagnostics-"));
    const stateDir = join(root, "state with spaces");
    const { socketPath } = await createTempSocketPath();
    const providerRegistryFactory = vi.fn(
      () =>
        new ProviderRegistry({
          worktree: new FakeWorktreeProvider({ now }),
          terminal: new FakeTerminalProvider({ now }),
          harnesses: [new FakeHarnessProvider({ now })],
        }),
    );
    const runtime = runObserverMain(
      ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "2000"],
      { providerRegistryFactory, buildVersion: observerBuildVersion },
    );
    const client = createObserverClient({ socketPath, requestId: ids("runtime-path") });

    try {
      await vi.waitFor(
        async () => {
          await expect(client.health()).resolves.toMatchObject({ stateDir, socketPath });
        },
        { timeout: 2000 },
      );
      const snapshot = await client.collectDiagnostics({ includeLogs: false });
      expect(snapshot.observerHealth).toMatchObject({ stateDir, socketPath });
      expect(snapshot.localState).toMatchObject({
        stateDir,
        entries: [
          { kind: "logs", path: join(stateDir, "logs") },
          { kind: "database", path: join(stateDir, "observer.sqlite") },
          { kind: "debug_bundles", path: join(stateDir, "diagnostics") },
          { kind: "hook_spool", path: join(stateDir, "spool", "hooks") },
        ],
      });
      expect(snapshot.hookSpool).toMatchObject({
        path: join(stateDir, "spool", "hooks"),
      });

      const report = await client.runDoctor();
      expect(report.observer).toMatchObject({ stateDir, socketPath });
      expect(report.logs.paths).toEqual([
        componentLogPath(stateDir, "observer"),
        componentLogPath(stateDir, "hook"),
      ]);
      expect(report.debugBundle.diagnosticsDir).toBe(join(stateDir, "diagnostics"));

      await client.stop();
      await expect(runtime).resolves.toBe(0);
      expect(providerRegistryFactory).toHaveBeenCalledOnce();
    } finally {
      await client.stop().catch(() => undefined);
      await runtime.catch(() => undefined);
    }
  });

  it("reports startup duplicate evidence without signaling or blocking health", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const stateDir = join(dir, "report-only-state");
    const processToken = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
    const keeperIdentity = createObserverProcessIdentity({
      pid: process.pid,
      processToken,
      version: observerBuildVersion,
      socketPath,
    });
    const keeperProcess = {
      pid: process.pid,
      argv: [process.execPath, "__observer", "--socket", socketPath],
      executablePath: process.execPath,
      startToken: keeperIdentity.osStartTime,
      processToken,
      buildVersion: observerBuildVersion,
      socketPath,
      startupTimeoutMs: 1,
    };
    const candidateProcess = {
      ...keeperProcess,
      pid: process.pid + 10_000,
      startToken: "candidate-start",
      processToken: ["b47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-"),
    };
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const duplicateProcessEvidence: ObserverDuplicateProcessEvidenceSource = {
      listObserverProcesses: () => [keeperProcess, candidateProcess],
      socketHolders: () => [process.pid],
      processStartToken: (pid) =>
        pid === process.pid ? keeperIdentity.osStartTime : "candidate-start",
      readProcessIdentity: readObserverProcessIdentity,
      socketIdentity: readSocketIdentity,
      unixSocketFdCount: () => 0,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        return "sent";
      },
    };
    const providerRegistryFactory = () =>
      new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [new FakeHarnessProvider({ now })],
      });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const runtime = runObserverMain(
      [
        "--socket",
        socketPath,
        "--state-dir",
        stateDir,
        "--startup-timeout-ms",
        "2000",
        "--build-version",
        observerBuildVersion,
        "--process-token",
        processToken,
      ],
      { providerRegistryFactory, buildVersion: observerBuildVersion, duplicateProcessEvidence },
    );
    const client = createObserverClient({ socketPath, requestId: ids("report-only") });

    try {
      await vi.waitFor(
        async () => {
          await expect(client.health()).resolves.toMatchObject({ pid: process.pid, socketPath });
        },
        { timeout: 2000 },
      );
      expect(signals).toEqual([]);
      await vi.waitFor(
        async () => {
          const report = await client.runDoctor();
          expect(report.checks).toContainEqual(
            expect.objectContaining({
              name: "observer-singleton",
              status: "warn",
              message: expect.stringContaining("reported but not signaled"),
            }),
          );
        },
        { timeout: 12_000, interval: 100 },
      );
      expect(signals).toEqual([]);
    } finally {
      await client.stop().catch(() => undefined);
      await runtime.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  }, 16_000);

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
    const groupReceipt = await client.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Protocol Group" },
    });
    await fixture.queue.drain();
    await expect(client.getCommand(groupReceipt.commandId)).resolves.toMatchObject({
      id: "cmd_2",
      status: "succeeded",
    });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      sessionGroups: [
        {
          id: expect.stringMatching(/^grp_/),
          projectId: "web",
          name: "Protocol Group",
          sessionIds: [],
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
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
    diagnosticEvidenceSource: new FakeDiagnosticEvidenceSource(),
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
