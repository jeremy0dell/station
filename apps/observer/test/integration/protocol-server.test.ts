import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  type ObserverProcessEvidenceSource,
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

  it("disconnects an overflowed event subscriber and accepts a fresh subscription", async () => {
    const { socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath, 2);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    const client = createObserverClient({ socketPath, requestId: ids("event-overflow") });
    const stalled = client.subscribe()[Symbol.asyncIterator]();
    const stalledNext = stalled.next();
    const event = {
      type: "observer.reconciled" as const,
      at: now,
      changed: 0,
    };

    try {
      await vi.waitFor(() => {
        expect(fixture.eventBus.health()).toMatchObject({ activeSubscribers: 1 });
      });
      fixture.eventBus.publish(event);
      fixture.eventBus.publish(event);
      fixture.eventBus.publish(event);
      fixture.eventBus.publish(event);

      await expect(stalledNext).rejects.toMatchObject({
        code: "PROTOCOL_SUBSCRIPTION_CLOSED",
      });
      await expect(client.health()).resolves.toMatchObject({
        eventBus: {
          activeSubscribers: 0,
          queuedEvents: 0,
          subscriberCapacity: 2,
          highWaterQueuedEvents: 2,
          overflowCount: 1,
          disconnectCount: 1,
          resyncRequiredCount: 1,
          lastOverflowReason: "subscriber-capacity",
        },
      });

      const fresh = client.subscribe()[Symbol.asyncIterator]();
      const freshNext = fresh.next();
      await vi.waitFor(() => {
        expect(fixture.eventBus.health()).toMatchObject({ activeSubscribers: 1 });
      });
      fixture.eventBus.publish(event);
      await expect(freshNext).resolves.toEqual({ done: false, value: event });
      await fresh.return?.();
      await vi.waitFor(() => {
        expect(fixture.eventBus.health()).toMatchObject({ activeSubscribers: 0, queuedEvents: 0 });
      });
    } finally {
      await stalled.return?.();
      await server.close();
      fixture.sqlite.close();
    }
  });

  it("does not report generic attach ready when startup cancellation wins", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    const originalSigtermListeners = new Set(process.listeners("SIGTERM"));
    const startupReadinessSink = { ready: vi.fn() };
    const providerRegistryFactory = vi.fn();

    try {
      await expect(
        runObserverMain(
          [
            "--socket",
            socketPath,
            "--state-dir",
            join(dir, "cancelled-attach-state"),
            "--startup-timeout-ms",
            "1000",
          ],
          {
            providerRegistryFactory,
            buildVersion: observerBuildVersion,
            startupReadinessSink,
            incumbentLifecycle: {
              health: async () => {
                const startupListener = process
                  .listeners("SIGTERM")
                  .find((listener) => !originalSigtermListeners.has(listener));
                expect(startupListener).toBeDefined();
                startupListener?.();
                return fixture.api.health();
              },
              stop: fixture.api.stop,
              socketListening: async () => true,
            },
          },
        ),
      ).rejects.toMatchObject({ code: "OBSERVER_STARTUP_CANCELLED" });
      expect(startupReadinessSink.ready).not.toHaveBeenCalled();
      expect(providerRegistryFactory).not.toHaveBeenCalled();
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

  it("preserves a verified incumbent when successor hook preparation fails", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    const incumbentIdentity = createObserverProcessIdentity({
      pid: process.pid,
      processToken: "00000000-0000-4000-8000-000000000001",
      version: observerBuildVersion,
      socketPath,
    });
    let incumbentListening = true;
    const stop = vi.fn(async () => {
      incumbentListening = false;
      await server.close();
      return {
        schemaVersion: "0.13.0" as const,
        stopped: true,
        at: now,
      };
    });
    const processEvidence: ObserverProcessEvidenceSource = {
      readObserverProcess: (pid) =>
        pid === incumbentIdentity.pid
          ? {
              pid,
              argv: [process.execPath, "__observer", "--socket", socketPath],
              executablePath: process.execPath,
              startToken: incumbentIdentity.osStartTime,
              processToken: incumbentIdentity.processToken,
              buildVersion: incumbentIdentity.version,
              socketPath,
            }
          : undefined,
      socketHolders: () => (incumbentListening ? [incumbentIdentity.pid] : []),
      processStartToken: (pid) =>
        incumbentListening && pid === incumbentIdentity.pid
          ? incumbentIdentity.osStartTime
          : undefined,
      readProcessIdentity: async () => ({ ...incumbentIdentity }),
      signal: () => "sent",
    };
    const harness = new FakeHarnessProvider({ id: "codex", now });
    harness.reconcileHooks = vi.fn(async () => ({
      provider: "codex",
      status: "post-write-doctor-failed",
      changed: true,
      verified: false,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED",
        message: "Codex hook writes were not verified by provider doctor.",
        provider: "codex",
      },
      followUp: { action: "run-doctor" },
    }));
    const providerRegistryFactory = vi.fn(
      () =>
        new ProviderRegistry({
          worktree: new FakeWorktreeProvider({ now }),
          terminal: new FakeTerminalProvider({ now }),
          harnesses: [harness],
        }),
    );
    const candidateBuildVersion = `0.0.1+station.${"b".repeat(64)}`;

    try {
      const failure = await runObserverMain(
        [
          "--socket",
          socketPath,
          "--state-dir",
          join(dir, "candidate-state"),
          "--startup-timeout-ms",
          "10000",
        ],
        {
          providerRegistryFactory,
          processEvidence,
          buildVersion: candidateBuildVersion,
          incumbentLifecycle: {
            health: () => fixture.api.health(),
            stop,
            socketListening: async () => incumbentListening,
          },
        },
      ).catch((error: unknown) => error);

      expect({
        code: (failure as { code?: string }).code,
        message: (failure as { message?: string }).message,
        causeCode: (failure as { cause?: { code?: string } }).cause?.code,
      }).toEqual({
        code: "OBSERVER_HANDOFF_REFUSED",
        message: "The incumbent Observer could not be replaced safely.",
        causeCode: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED",
      });
      expect(providerRegistryFactory).toHaveBeenCalledOnce();
      expect(harness.reconcileHooks).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      await expect(probeObserverSocket(socketPath)).resolves.toMatchObject({
        status: "listening",
      });
    } finally {
      await server.close().catch(() => undefined);
      fixture.sqlite.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defers a post-commit signal until the replacement owns startup cleanup", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const fixture = createObserverFixture(socketPath);
    const server = await startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });
    const incumbentIdentity = createObserverProcessIdentity({
      pid: process.pid,
      processToken: "00000000-0000-4000-8000-000000000001",
      version: observerBuildVersion,
      socketPath,
    });
    const originalSigtermListeners = new Set(process.listeners("SIGTERM"));
    let incumbentListening = true;
    const stop = vi.fn(async () => {
      const startupListener = process
        .listeners("SIGTERM")
        .find((listener) => !originalSigtermListeners.has(listener));
      expect(startupListener).toBeDefined();
      startupListener?.();
      incumbentListening = false;
      await server.close();
      return {
        schemaVersion: "0.13.0" as const,
        stopped: true,
        at: now,
      };
    });
    const processEvidence: ObserverProcessEvidenceSource = {
      readObserverProcess: (pid) =>
        pid === incumbentIdentity.pid
          ? {
              pid,
              argv: [process.execPath, "__observer", "--socket", socketPath],
              executablePath: process.execPath,
              startToken: incumbentIdentity.osStartTime,
              processToken: incumbentIdentity.processToken,
              buildVersion: incumbentIdentity.version,
              socketPath,
            }
          : undefined,
      socketHolders: () => (incumbentListening ? [incumbentIdentity.pid] : []),
      processStartToken: (pid) =>
        incumbentListening && pid === incumbentIdentity.pid
          ? incumbentIdentity.osStartTime
          : undefined,
      readProcessIdentity: async () => ({ ...incumbentIdentity }),
      signal: (_pid, signal) => (signal === 0 && !incumbentListening ? "absent" : "sent"),
    };
    const harness = new FakeHarnessProvider({ id: "codex", now });
    harness.reconcileHooks = vi.fn(async () => ({
      provider: "codex",
      status: "healthy",
      changed: false,
      verified: true,
    }));
    const candidateStateDir = join(dir, "post-commit-signal-state");

    try {
      await expect(
        runObserverMain(
          [
            "--socket",
            socketPath,
            "--state-dir",
            candidateStateDir,
            "--startup-timeout-ms",
            "10000",
          ],
          {
            providerRegistryFactory: () =>
              new ProviderRegistry({
                worktree: new FakeWorktreeProvider({ now }),
                terminal: new FakeTerminalProvider({ now }),
                harnesses: [harness],
              }),
            processEvidence,
            buildVersion: `0.0.1+station.${"b".repeat(64)}`,
            incumbentLifecycle: {
              health: () => fixture.api.health(),
              stop,
              socketListening: async () => incumbentListening,
            },
          },
        ),
      ).resolves.toBe(0);

      expect(stop).toHaveBeenCalledOnce();
      expect(harness.reconcileHooks).toHaveBeenCalledOnce();
      await expect(access(join(candidateStateDir, "observer.sqlite"))).resolves.toBeUndefined();
      await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close().catch(() => undefined);
      fixture.sqlite.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a post-bind publication failure with its original cause after cleanup", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const stateDir = join(dir, "publication-failure-state");

    const failure = await runObserverMain(
      ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "1000"],
      {
        providerRegistryFactory: async () => {
          // Repair has completed by provider construction; introduce the collision
          // here so the successful binder still owns the publication failure.
          await mkdir(`${socketPath}.pid`);
          return new ProviderRegistry({
            worktree: new FakeWorktreeProvider({ now }),
            terminal: new FakeTerminalProvider({ now }),
            harnesses: [new FakeHarnessProvider({ now })],
          });
        },
        buildVersion: observerBuildVersion,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: expect.stringMatching(/EISDIR|ENOTDIR/u) });
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(dir, { recursive: true, force: true });
  });

  it("reconciles configured hooks under the boot claim before runtime publication", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const stateDir = join(dir, "hook-reconciliation-state");
    const reconciliationStarted = deferred();
    const releaseReconciliation = deferred();
    const harness = new FakeHarnessProvider({ id: "codex", now });
    harness.reconcileHooks = async () => {
      reconciliationStarted.resolve();
      await releaseReconciliation.promise;
      return {
        provider: "codex",
        status: "repaired",
        changed: true,
        verified: true,
      };
    };
    const runtime = runObserverMain(
      ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "2000"],
      {
        providerRegistryFactory: () =>
          new ProviderRegistry({
            worktree: new FakeWorktreeProvider({ now }),
            terminal: new FakeTerminalProvider({ now }),
            harnesses: [harness],
          }),
        buildVersion: observerBuildVersion,
      },
    );
    const client = createObserverClient({ socketPath, requestId: ids("hook-reconcile") });

    try {
      await reconciliationStarted.promise;
      await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(`${socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(stateDir, "observer.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      releaseReconciliation.resolve();
      await vi.waitFor(
        async () => {
          await expect(probeObserverSocket(socketPath)).resolves.toMatchObject({
            status: "listening",
          });
        },
        { timeout: 2000 },
      );
      await expect(client.health()).resolves.toMatchObject({ status: "healthy" });
    } finally {
      releaseReconciliation.resolve();
      await client.stop().catch(() => undefined);
      await runtime.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails startup without publishing runtime state when hook repair is unverified", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const stateDir = join(dir, "hook-reconciliation-failure-state");
    const harness = new FakeHarnessProvider({ id: "codex", now });
    harness.reconcileHooks = async () => ({
      provider: "codex",
      status: "post-write-doctor-failed",
      changed: true,
      verified: false,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED",
        message: "Codex hook writes were not verified by provider doctor.",
        provider: "codex",
      },
      followUp: { action: "run-doctor" },
    });

    await expect(
      runObserverMain(
        ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "2000"],
        {
          providerRegistryFactory: () =>
            new ProviderRegistry({
              worktree: new FakeWorktreeProvider({ now }),
              terminal: new FakeTerminalProvider({ now }),
              harnesses: [harness],
            }),
          buildVersion: observerBuildVersion,
        },
      ),
    ).rejects.toMatchObject({ code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED" });
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${socketPath}.pid`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(stateDir, "observer.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(dir, { recursive: true, force: true });
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
      readObserverProcess: (pid) =>
        [keeperProcess, candidateProcess].find((entry) => entry.pid === pid),
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

  it("keeps operations gated until startup reconcile commits current provider state", async () => {
    const { dir, socketPath } = await createTempSocketPath();
    const stateDir = join(dir, "startup-context-state");
    const providerReadStarted = deferred();
    const releaseProviderRead = deferred();
    const terminal = new FakeTerminalProvider({ now });
    const startupReadinessSink = { ready: vi.fn() };
    vi.spyOn(terminal, "listTargets").mockImplementation(async () => {
      providerReadStarted.resolve();
      await releaseProviderRead.promise;
      return [];
    });
    const runtime = runObserverMain(
      ["--socket", socketPath, "--state-dir", stateDir, "--startup-timeout-ms", "2000"],
      {
        providerRegistryFactory: () =>
          new ProviderRegistry({
            worktree: new FakeWorktreeProvider({ now }),
            terminal,
            harnesses: [new FakeHarnessProvider({ now })],
          }),
        buildVersion: observerBuildVersion,
        startupReadinessSink,
      },
    );
    const client = createObserverClient({ socketPath, requestId: ids("startup-context") });

    try {
      await providerReadStarted.promise;
      await expect(client.getSnapshot()).rejects.toMatchObject({ code: "OBSERVER_NOT_READY" });
      releaseProviderRead.resolve();
      await expect(client.health()).resolves.toMatchObject({
        lastReconcile: { reason: "observer.startup" },
      });
      expect(startupReadinessSink.ready).toHaveBeenCalledOnce();
      await expect(client.getSnapshot()).resolves.toMatchObject({ observer: { healthy: true } });
    } finally {
      releaseProviderRead.resolve();
      await client.stop().catch(() => undefined);
      await runtime.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
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
    const groupReceipt = await client.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Protocol Group" },
    });
    await fixture.queue.drain();
    await expect(client.getCommand(groupReceipt.commandId)).resolves.toMatchObject({
      id: "cmd_2",
      status: "succeeded",
      result: {
        type: "sessionGroup.create",
        projectId: "web",
        groupId: expect.stringMatching(/^grp_/),
        version: 1,
      },
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

function createObserverFixture(socketPath: string, subscriberCapacity?: number) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const persistence = createSqliteObserverPersistence({
    sqlite,
    clock,
    idFactory: observerIds(),
  });
  const eventBus = createObserverEventBus(
    subscriberCapacity === undefined ? {} : { subscriberCapacity },
  );
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
  return { api, queue, eventBus, sqlite, clock };
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
