import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import { type SessionRecoveryHandle, STATION_SCHEMA_VERSION } from "@station/contracts";
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
      canonicalTitleImport: true,
      harnesses: [{ provider: "fake-harness", canResume: true }],
    });
    const reconcileSpy = vi.spyOn(core, "reconcile");
    const worktreeReadSpy = vi.spyOn(providers.worktree, "listWorktrees");
    const terminalReadSpy = vi.spyOn(providers.terminal, "listTargets");
    const harness = providers.harnesses.get("fake-harness");
    if (harness === undefined) throw new Error("Expected fake harness provider.");
    const harnessReadSpy = vi.spyOn(harness, "discoverRuns");
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    await expect(api.getSessionRecoveryInventory()).resolves.toEqual({
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [],
    });
    await expect(api.getSessionRecoveryInventory()).resolves.toEqual({
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [],
    });
    expect(cloneSpy).toHaveBeenCalledTimes(2);
    cloneSpy.mockRestore();
    const graphReadSpy = vi.spyOn(core, "getSnapshot");
    const inventoryReadSpy = vi.spyOn(persistence, "readRecoveryInventory");
    await expect(api.getSessionRecoveryAssessment()).resolves.toEqual({
      schemaVersion: 1,
      inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
      resumeEnabled: false,
      providerCapabilities: [],
      sessions: [],
    });
    expect(graphReadSpy).toHaveBeenCalledOnce();
    expect(inventoryReadSpy).toHaveBeenCalledOnce();
    graphReadSpy.mockRestore();
    inventoryReadSpy.mockRestore();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(worktreeReadSpy).not.toHaveBeenCalled();
    expect(terminalReadSpy).not.toHaveBeenCalled();
    expect(harnessReadSpy).not.toHaveBeenCalled();
    await expect(persistence.listCommands()).resolves.toEqual([]);
    await expect(persistence.listEvents()).resolves.toEqual([]);

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
    await expect(api.getSnapshot()).resolves.not.toHaveProperty("debug");
    await expect(api.getSnapshot({ includeDebug: true })).resolves.toMatchObject({
      debug: {
        terminal: {
          reconciledAt: now,
          providerReads: [{ provider: "fake-terminal", status: "complete" }],
          targets: [expect.objectContaining({ id: "term_web_task" })],
        },
      },
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

    const group = await api.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "API Group", initialSessionIds: ["ses_web_task"] },
    });
    await commandQueue.drain();
    await expect(api.getCommand(group.commandId)).resolves.toMatchObject({
      status: "succeeded",
      result: {
        type: "sessionGroup.create",
        projectId: "web",
        groupId: expect.stringMatching(/^grp_/),
        version: 1,
      },
    });
    expect((await api.getSnapshot()).sessionGroups).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^grp_/),
        name: "API Group",
        sessionIds: ["ses_web_task"],
      }),
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

    const expectedHookReceipt = {
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_memory_1",
      provider: "fake-harness",
      event: "run.updated",
      status: "accepted",
      receivedAt: now,
    };
    expect(firstHook).toEqual(expectedHookReceipt);
    expect(duplicateHook).toEqual(expectedHookReceipt);
    await expect(hookReconcile).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await expect(persistence.listEvents({ type: "providerHook.ingested" })).resolves.toHaveLength(
      1,
    );
    await expect(
      persistence.listProviderObservations({ entityKind: "harness_event" }),
    ).resolves.toEqual([]);
    await hookEvents.return?.();

    await expect(api.health()).resolves.toMatchObject({
      status: "healthy",
      sqlite: healthStub,
      eventBus: {
        activeSubscribers: 0,
        queuedEvents: 0,
        subscriberCapacity: 1_024,
        overflowCount: 0,
        disconnectCount: 0,
        resyncRequiredCount: 0,
      },
    });
    await expect(api.collectDiagnostics({ includeLogs: false })).resolves.toMatchObject({
      observerHealth: {
        sqlite: healthStub,
        stateDir: "memory://state",
        socketPath: "memory://observer-socket",
      },
      localState: { stateDir: "memory://state" },
      hookSpool: { path: "urn:station:hook-spool" },
      commands: expect.arrayContaining([
        expect.objectContaining({ id: group.commandId, status: "succeeded" }),
        expect.objectContaining({ id: command.commandId, status: "succeeded" }),
      ]),
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

  it("reads one detached recovery snapshot without committing it as backing state", async () => {
    const persistence = createInMemoryObserverPersistence();
    await persistence.seedSession({
      sessionId: "session-snapshot",
      projectId: "web",
      worktreeId: "worktree-snapshot",
      initialTitle: "Snapshot",
      harness: "codex",
      terminalProvider: "station",
      createdAt: now,
      lastSeenAt: now,
    });
    const recoveryHandle: SessionRecoveryHandle = {
      id: "ignored-snapshot-handle",
      provider: "codex",
      projectId: "web",
      worktreeId: "worktree-snapshot",
      sessionId: "session-snapshot",
      target: { kind: "native-session", id: "native-snapshot" },
      observedAt: now,
      lastSeenAt: now,
    };
    await persistence.upsertSessionRecoveryHandle(recoveryHandle);

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const snapshot = await persistence.readRecoveryInventory();
    expect(cloneSpy).toHaveBeenCalledOnce();
    cloneSpy.mockRestore();

    const session = snapshot.sessions[0];
    const handle = snapshot.recoveryHandles[0];
    if (session === undefined || handle === undefined) {
      throw new Error("Expected detached recovery inventory evidence.");
    }
    session.lifecycle = "ended";
    handle.projectId = "mutated-project";

    await expect(persistence.readRecoveryInventory()).resolves.toEqual({
      sessions: [expect.objectContaining({ id: "session-snapshot", lifecycle: "open" })],
      recoveryHandles: [expect.objectContaining({ projectId: "web" })],
    });
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
      new FakeHarnessProvider({
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
