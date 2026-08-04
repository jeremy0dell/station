import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { type HarnessEventObservation, STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import { createCommandQueue } from "../../src/commands/queue";
import { registerObserverCommandHandlers } from "../../src/commands/router";
import type { PersistenceHealthSource } from "../../src/persistence/ports";
import { ProviderRegistry } from "../../src/providers/registry";
import { createObserverCore, type ObserverCore } from "../../src/reconcile/core";
import { createObserverApi } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";
import { FakeDiagnosticEvidenceSource } from "../support/diagnosticEvidenceSources.js";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";
import {
  FakeWorktreeChangeSource,
  FakeWorktreeMetadataInvalidationSource,
} from "../support/worktreeMetadataSources.js";

const now = "2026-05-20T12:00:00.000Z";
const healthStub = {
  path: "/health-stub/observer.sqlite",
  open: true,
  status: "healthy" as const,
  schemaVersion: 12,
  lastCheckedAt: now,
};

describe("Observer API composition with in-memory persistence", () => {
  it("runs core, commands, ingress, diagnostics, and shutdown without SQLite", async () => {
    const clock = { now: () => new Date(now) };
    const idFactory = observerIds();
    const persistence = createInMemoryObserverPersistence({ clock, idFactory });
    const eventBus = createObserverEventBus();
    const commandQueue = createCommandQueue({ persistence, clock, idFactory, eventBus });
    const providers = fakeProviders();
    const core = createObserverCore({ config, providers, persistence, clock });
    const lifecycle: string[] = [];
    const worktreeChangeSource = new FakeWorktreeChangeSource();
    const worktreeMetadataInvalidationSource = new FakeWorktreeMetadataInvalidationSource();
    worktreeMetadataInvalidationSource.onShutdown = async () => {
      lifecycle.push("metadata");
    };
    const persistenceHealth: PersistenceHealthSource = { health: () => healthStub };
    const diagnosticEvidenceSource = new FakeDiagnosticEvidenceSource();
    const api = createObserverApi({
      core,
      providers,
      persistence,
      persistenceHealth,
      commandQueue,
      eventBus,
      diagnosticEvidenceSource,
      clock,
      config,
      hookReconcileDebounceMs: 0,
      worktreeChangeSource,
      worktreeMetadataInvalidationSource,
      onStop: async () => {
        lifecycle.push("onStop");
        await commandQueue.shutdown();
      },
    });
    registerObserverCommandHandlers({
      projectConfigWriter: createUnexpectedProjectConfigWriter(),
      queue: commandQueue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
    });

    await expect(api.getSessionRecoveryReadiness()).resolves.toEqual({
      resumeEnabled: false,
      harnesses: [{ provider: "fake-harness", canResume: true }],
    });

    const initialEvents = api.subscribe({ type: "observer.reconciled" })[Symbol.asyncIterator]();
    const initialEvent = initialEvents.next();
    const initial = await api.reconcile("in-memory-integration");

    await expect(initialEvent).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    expect(initial.snapshot).toMatchObject({
      projects: [{ id: "web" }],
      rows: [
        {
          id: "wt_web_task",
          agent: { sessionId: "ses_web_task", harness: "fake-harness" },
        },
      ],
      sessions: [
        {
          id: "ses_web_task",
          projectId: "web",
          worktreeId: "wt_web_task",
          harness: { provider: "fake-harness", runId: "run_web_task" },
        },
      ],
    });
    await initialEvents.return?.();
    await waitFor(() => worktreeChangeSource.requests.length > 0);
    expect(worktreeChangeSource.requests[0]?.target).toMatchObject({
      worktreeId: "wt_web_task",
      projectId: "web",
      branch: "task",
    });
    expect(worktreeMetadataInvalidationSource.replacements[0]).toEqual([
      expect.objectContaining({ worktreeId: "wt_web_task", projectId: "web", branch: "task" }),
    ]);

    const command = await api.dispatch({
      type: "observer.reconcile",
      payload: { reason: "in-memory-command" },
    });
    await commandQueue.drain();
    await expect(api.getCommand(command.commandId)).resolves.toMatchObject({
      id: command.commandId,
      status: "succeeded",
    });

    const hookEvents = api.subscribe({ type: "observer.reconciled" })[Symbol.asyncIterator]();
    const hookReconcile = hookEvents.next();
    const hook = {
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_memory_1",
      provider: "fake-harness",
      kind: "harness" as const,
      event: "run.updated",
      receivedAt: now,
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      payload: { state: "idle" },
    };
    const firstHook = await api.ingestProviderHookEvent(hook);
    const duplicateHook = await api.ingestProviderHookEvent(hook);

    expect(firstHook).toMatchObject({ accepted: true, deduped: false });
    expect(duplicateHook).toMatchObject({ accepted: true, deduped: true });
    await expect(hookReconcile).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await expect(persistence.listEvents({ type: "providerHook.ingested" })).resolves.toHaveLength(
      1,
    );
    await expect(
      persistence.listProviderObservations({ entityKind: "harness_event" }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "fake-harness",
        entityKind: "harness_event",
        entityKey: "run_web_task",
      }),
    ]);
    await hookEvents.return?.();

    await expect(api.health()).resolves.toMatchObject({
      status: "healthy",
      sqlite: healthStub,
    });
    await expect(api.collectDiagnostics({ includeLogs: false })).resolves.toMatchObject({
      observerHealth: {
        sqlite: healthStub,
        stateDir: "memory://state",
        socketPath: "memory://observer-socket",
      },
      localState: { stateDir: "memory://state" },
      hookSpool: { path: "urn:station:hook-spool" },
      commands: [expect.objectContaining({ id: command.commandId, status: "succeeded" })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "providerHook.ingested", hookId: "hook_memory_1" }),
      ]),
    });
    await expect(api.runDoctor()).resolves.toMatchObject({
      logs: { paths: ["queue://observer-log", "queue://hook-log"] },
      debugBundle: { diagnosticsDir: "memory://diagnostics" },
    });
    expect(diagnosticEvidenceSource.readRecentLogsCalls).toEqual([50]);

    await expect(api.stop()).resolves.toMatchObject({ stopped: true, at: now });
    expect(worktreeMetadataInvalidationSource.shutdownCount).toBe(1);
    expect(lifecycle).toEqual(["metadata", "onStop"]);
    const requestsAfterStop = worktreeChangeSource.requests.length;
    await api.reconcile("after-stop-direct-test");
    await settleBackgroundWork();
    expect(worktreeChangeSource.requests).toHaveLength(requestsAfterStop);
    await expect(commandQueue.drain()).resolves.toBeUndefined();
  });

  it("clears cached local evidence when composition sees a matching missing worktree", async () => {
    const clock = { now: () => new Date(now) };
    const idFactory = observerIds();
    const persistence = createInMemoryObserverPersistence({ clock, idFactory });
    const eventBus = createObserverEventBus();
    const commandQueue = createCommandQueue({ persistence, clock, idFactory, eventBus });
    const providers = fakeProviders();
    const core = createObserverCore({ config, providers, persistence, clock });
    const missingSnapshot = structuredClone(await core.reconcile("missing-worktree-fixture"));
    const row = missingSnapshot.rows.find((candidate) => candidate.id === "wt_web_task");
    if (row === undefined) throw new Error("Expected fake worktree row.");
    row.worktree.state = "missing";
    const missingCore: ObserverCore = {
      ...core,
      reconcile: async () => missingSnapshot,
      getSnapshot: () => missingSnapshot,
    };
    await persistence.upsertWorktreeMetadataCurrent({
      worktreeId: row.id,
      kind: "change_summary",
      cacheKey: "cached-before-missing",
      expiresAt: "2026-05-20T12:05:00.000Z",
      payload: {
        kind: "branch_diff",
        additions: 3,
        deletions: 1,
        source: "local_git",
        checkedAt: now,
      },
    });
    const invalidationSource = new FakeWorktreeMetadataInvalidationSource();
    const api = createObserverApi({
      core: missingCore,
      providers,
      persistence,
      persistenceHealth: { health: () => healthStub },
      commandQueue,
      eventBus,
      diagnosticEvidenceSource: new FakeDiagnosticEvidenceSource(),
      clock,
      config,
      worktreeMetadataInvalidationSource: invalidationSource,
      onStop: async () => commandQueue.shutdown(),
    });

    await api.reconcile("missing-worktree-cache-clear");
    await waitFor(async () => {
      const rows = await persistence.listWorktreeMetadataCurrent({
        kind: "change_summary",
        includeExpired: true,
        now,
      });
      return rows.length === 0;
    });

    expect(invalidationSource.replacements[0]).toEqual([]);
    await expect(api.stop()).resolves.toMatchObject({ stopped: true });
  });

  it("waits for an in-flight provider health publication before stopping", async () => {
    const clock = { now: () => new Date(now) };
    const idFactory = observerIds();
    const persistence = createInMemoryObserverPersistence({ clock, idFactory });
    const eventBus = createObserverEventBus();
    const commandQueue = createCommandQueue({ persistence, clock, idFactory, eventBus });
    const providers = fakeProviders();
    const core = createObserverCore({ config, providers, persistence, clock });
    const commitProviderHealthProbe = core.commitProviderHealthProbe.bind(core);
    let releaseCommit: () => void = () => undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let markCommitStarted: () => void = () => undefined;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    vi.spyOn(core, "commitProviderHealthProbe").mockImplementation(async (health) => {
      markCommitStarted();
      await commitBlocked;
      return commitProviderHealthProbe(health);
    });
    let markMetadataStopped: () => void = () => undefined;
    const metadataStopped = new Promise<void>((resolve) => {
      markMetadataStopped = resolve;
    });
    const onStop = vi.fn(async () => undefined);
    const api = createObserverApi({
      core,
      providers,
      persistence,
      persistenceHealth: { health: () => healthStub },
      commandQueue,
      eventBus,
      diagnosticEvidenceSource: new FakeDiagnosticEvidenceSource(),
      clock,
      config,
      metadataRefresh: {
        refresh: async () => undefined,
        shutdown: async () => markMetadataStopped(),
      },
      onStop,
    });

    const refresh = providers.healthCache.refresh(providers.worktree.id);
    await commitStarted;
    const stop = api.stop();
    await metadataStopped;

    expect(onStop).not.toHaveBeenCalled();
    releaseCommit();
    await expect(stop).resolves.toMatchObject({ stopped: true });
    await expect(refresh).resolves.toBeUndefined();
    expect(onStop).toHaveBeenCalledOnce();
  });
});

function fakeProviders(): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_task",
          projectId: "web",
          branch: "task",
          path: "/tmp/station/web/task",
          now,
        }),
      ],
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "term_web_task",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          harnessRunId: "run_web_task",
          cwd: "/tmp/station/web/task",
          harnessBinding: { role: "main-agent", harnessProvider: "fake-harness" },
          now,
        }),
      ],
    }),
    harnesses: [
      new NoSqliteHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_web_task",
            projectId: "web",
            worktreeId: "wt_web_task",
            sessionId: "ses_web_task",
            cwd: "/tmp/station/web/task",
            state: "idle",
            now,
          }),
        ],
      }),
    ],
  });
}

class NoSqliteHarnessProvider extends FakeHarnessProvider {
  override async ingestEvent(): Promise<HarnessEventObservation[]> {
    return [
      {
        provider: this.id,
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        harnessRunId: "run_web_task",
        status: {
          value: "idle",
          confidence: "high",
          reason: "Fake harness hook reported idle.",
          source: "harness_event",
          updatedAt: now,
        },
        observedAt: now,
      },
    ];
  }
}

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    errorId: () => `err_${++error}`,
    observationId: () => `obs_${++observation}`,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for background metadata work.");
}

async function settleBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
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
      worktrunk: { enabled: true },
    },
  ],
};
