import type { StationConfig } from "@station/config";
import { type HarnessEventObservation, STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createCommandQueue } from "../../src/commands/queue";
import { registerObserverCommandHandlers } from "../../src/commands/router";
import type { PersistenceHealthSource } from "../../src/persistence/ports";
import { ProviderRegistry } from "../../src/providers/registry";
import { createObserverCore } from "../../src/reconcile/core";
import { createObserverApi } from "../../src/runtime/api";
import { createObserverEventBus } from "../../src/runtime/eventBus";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";

const now = "2026-05-20T12:00:00.000Z";
const healthStub = {
  path: "/health-stub/observer.sqlite",
  open: true,
  status: "healthy" as const,
  schemaVersion: 12,
  lastCheckedAt: now,
};

describe("Observer API with in-memory persistence", () => {
  it("runs core, commands, ingress, diagnostics, and shutdown without SQLite", async () => {
    const clock = { now: () => new Date(now) };
    const idFactory = observerIds();
    const persistence = createInMemoryObserverPersistence({ clock, idFactory });
    const eventBus = createObserverEventBus();
    const commandQueue = createCommandQueue({ persistence, clock, idFactory, eventBus });
    const providers = fakeProviders();
    const core = createObserverCore({ config, providers, persistence, clock });
    let metadataStopped = false;
    const persistenceHealth: PersistenceHealthSource = { health: () => healthStub };
    const api = createObserverApi({
      core,
      providers,
      persistence,
      persistenceHealth,
      commandQueue,
      eventBus,
      clock,
      config,
      stateDir: "/tmp/station-no-sqlite-observer",
      hookReconcileDebounceMs: 0,
      metadataRefresh: {
        refresh: async () => undefined,
        shutdown: async () => {
          metadataStopped = true;
        },
      },
      onStop: () => commandQueue.shutdown(),
    });
    registerObserverCommandHandlers({
      queue: commandQueue,
      core,
      providers,
      projects: config.projects,
      persistence,
      eventBus,
      clock,
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
      observerHealth: { sqlite: healthStub },
      commands: [expect.objectContaining({ id: command.commandId, status: "succeeded" })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: "providerHook.ingested", hookId: "hook_memory_1" }),
      ]),
    });

    await expect(api.stop()).resolves.toMatchObject({ stopped: true, at: now });
    expect(metadataStopped).toBe(true);
    await expect(commandQueue.drain()).resolves.toBeUndefined();
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
      worktrunk: { enabled: true },
    },
  ],
};
