import type { StationConfig } from "@station/config";
import type { HarnessEventReportReceipt, ProviderHookAdapter } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  createCommandQueue,
  createHarnessEventReportIngestion,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
} from "../../src/internal";
import { createTestObserver } from "../support/testObserver";

const now = "2026-05-20T12:00:00.000Z";

describe("observer provider hook ingress", () => {
  it("persists a provider hook event, publishes it, and schedules reconciliation", async () => {
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, eventBus, api } = createTestObserver({ config, providers, clock });
    const events = eventBus.subscribe()[Symbol.asyncIterator]();
    const reconciled = nextObserverReconciled(eventBus);
    const nextEvent = events.next();

    const receipt = await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      provider: "worktrunk",
      kind: "worktree",
      event: "worktree.created",
      receivedAt: now,
    });

    expect(receipt).toMatchObject({
      accepted: true,
      status: "ingested",
      reconciled: false,
    });
    await expect(nextEvent).resolves.toMatchObject({
      value: { type: "providerHook.ingested", provider: "worktrunk" },
    });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    expect((await persistence.listEvents()).map((event) => event.type)).toEqual([
      "providerHook.ingested",
      "observer.reconciled",
    ]);
    await events.return?.();
    await reconciled.close();
    sqlite.close();
  });

  it("persists provider-neutral harness event reports and schedules reconciliation", async () => {
    const clock = { now: () => new Date(now) };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
    });
    const { sqlite, persistence, eventBus, api } = createTestObserver({ config, providers, clock });
    const events = eventBus.subscribe({ type: "harness.eventReported" })[Symbol.asyncIterator]();
    const reconciled = nextObserverReconciled(eventBus);

    const receipt = await api.reportHarnessEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: "report_codex_1",
      provider: "codex",
      kind: "harness",
      eventType: "PreToolUse",
      observedAt: now,
      status: {
        value: "working",
        confidence: "medium",
        reason: "Codex is about to use Bash.",
        source: "harness_event",
        updatedAt: now,
      },
      correlation: {
        worktreeId: "wt_web_task",
        cwd: "/tmp/station/web/task",
      },
      diagnostics: {
        rawEventType: "PreToolUse",
        payloadBytes: 4096,
        compactedBytes: 512,
        compacted: true,
        omittedFieldNames: ["tool_input"],
      },
      providerData: {
        toolName: "Bash",
      },
    });

    expect(receipt).toMatchObject({
      accepted: true,
      status: "accepted",
      projected: false,
      scheduledReconcile: true,
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "harness.eventReported",
        reportId: "report_codex_1",
        provider: "codex",
        eventType: "PreToolUse",
      },
    });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "wt_web_task",
          expiresAt: "2026-06-03T12:00:00.000Z",
          payload: expect.objectContaining({
            provider: "codex",
            worktreeId: "wt_web_task",
            rawEventType: "PreToolUse",
            reportId: "report_codex_1",
            eventType: "PreToolUse",
            diagnostics: expect.objectContaining({
              compacted: true,
            }),
            status: expect.objectContaining({
              value: "working",
              source: "harness_event",
            }),
            providerData: expect.objectContaining({
              toolName: "Bash",
            }),
          }),
        }),
      ]),
    );
    await events.return?.();
    await reconciled.close();
    sqlite.close();
  });

  it("normalizes harness hook events observer-side through the provider hook adapter", async () => {
    const clock = { now: () => new Date(now) };
    const adapter: ProviderHookAdapter = {
      provider: "fake-harness",
      kind: "harness",
      decideScope: (event) =>
        (event.payload as { owned?: boolean } | undefined)?.owned === true
          ? { action: "accept", reason: "station-env" }
          : { action: "ignore", reason: "missing-station-env" },
      toHarnessEventReport: (input) => ({
        ok: true,
        report: {
          schemaVersion: STATION_SCHEMA_VERSION,
          reportId: `fake:${input.event.hookId}`,
          provider: "fake-harness",
          kind: "harness",
          eventType: input.event.event,
          observedAt: input.event.receivedAt,
          status: {
            value: "needs_attention",
            confidence: "high",
            reason: "Fake harness requested user input.",
            source: "harness_event",
            updatedAt: input.event.receivedAt,
            attention: "question",
          },
          correlation: { worktreeId: "wt_web_task" },
        },
      }),
    };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new FakeHarnessProvider({ now })],
      hookAdapters: [adapter],
    });
    const { sqlite, persistence, api } = createTestObserver({ config, providers, clock });

    const receipt = await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_adapter_1",
      provider: "fake-harness",
      kind: "harness",
      event: "request_user_input",
      receivedAt: now,
      payload: { owned: true },
    });
    expect(receipt).toMatchObject({ accepted: true, status: "ingested" });

    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "fake-harness",
          entityKind: "harness_event",
          payload: expect.objectContaining({
            reportId: "fake:hook_adapter_1",
            eventType: "request_user_input",
            status: expect.objectContaining({
              value: "needs_attention",
              attention: "question",
            }),
          }),
        }),
      ]),
    );

    const ignored = await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_adapter_2",
      provider: "fake-harness",
      kind: "harness",
      event: "request_user_input",
      receivedAt: now,
      payload: { owned: false },
    });
    expect(ignored).toMatchObject({ accepted: false, status: "ignored" });

    sqlite.close();
  });

  it("acks harness event reports before slow queue processing finishes", async () => {
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const eventBus = createObserverEventBus();
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      persistence,
      sqlite,
      clock,
    });
    const gate = deferred();
    const api = createObserverApi({
      core,
      persistence,
      commandQueue: createCommandQueue({ persistence, clock, idFactory: ids(), eventBus }),
      eventBus,
      clock,
      harnessEventReportIngestion: {
        ingest: async (report): Promise<HarnessEventReportReceipt> => {
          await gate.promise;
          return acceptedReportReceipt(report.reportId, report.provider, report.eventType);
        },
      },
    });

    const receipt = await api.reportHarnessEvent(harnessReport("report_slow_1"));

    expect(receipt).toMatchObject({
      accepted: true,
      status: "accepted",
      scheduledReconcile: true,
    });
    await expect(api.health()).resolves.toMatchObject({
      harnessIngressQueue: {
        depth: 1,
        enqueued: 1,
        processed: 0,
      },
    });

    gate.resolve();
    await waitFor(async () => (await api.health()).harnessIngressQueue?.processed === 1);
    sqlite.close();
  });

  it("coalesces repeated harness reports and exposes queue metrics", async () => {
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const eventBus = createObserverEventBus();
    const core = createObserverCore({
      config,
      providers: new ProviderRegistry({
        worktree: new FakeWorktreeProvider({ now }),
        terminal: new FakeTerminalProvider({ now }),
        harnesses: [new FakeHarnessProvider({ now })],
      }),
      persistence,
      sqlite,
      clock,
    });
    const gate = deferred();
    const api = createObserverApi({
      core,
      persistence,
      commandQueue: createCommandQueue({ persistence, clock, idFactory: ids(), eventBus }),
      eventBus,
      clock,
      harnessEventReportIngestion: {
        ingest: async (report): Promise<HarnessEventReportReceipt> => {
          await gate.promise;
          return acceptedReportReceipt(report.reportId, report.provider, report.eventType);
        },
      },
    });

    const receipts = await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        api.reportHarnessEvent(harnessReport(`report_coalesced_${index}`)),
      ),
    );

    expect(receipts).toHaveLength(1000);
    expect(receipts.every((receipt) => receipt.status === "accepted")).toBe(true);
    await expect(api.health()).resolves.toMatchObject({
      harnessIngressQueue: {
        depth: 1,
        enqueued: 1000,
        coalesced: 999,
        dropped: 0,
        processed: 0,
      },
    });

    gate.resolve();
    await waitFor(async () => (await api.health()).harnessIngressQueue?.processed === 1);
    await expect(api.health()).resolves.toMatchObject({
      harnessIngressQueue: {
        depth: 0,
        processed: 1,
      },
    });
    sqlite.close();
  });

  it("deduplicates hook ids before provider dispatch and persistence", async () => {
    const clock = { now: () => new Date(now) };
    const harness = new RecordingHarnessProvider({ now });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [harness],
    });
    const { sqlite, persistence, eventBus, api } = createTestObserver({ config, providers, clock });
    const reconciled = nextObserverReconciled(eventBus);
    const event = {
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_dedupe_1",
      provider: "fake-harness",
      kind: "harness" as const,
      event: "run.updated",
      receivedAt: now,
      payload: { state: "idle" },
    };

    const first = await api.ingestProviderHookEvent(event);
    const second = await api.ingestProviderHookEvent(event);

    expect(first).toMatchObject({ status: "ingested", deduped: false });
    expect(second).toMatchObject({ status: "ingested", deduped: true, reconciled: false });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await reconciled.close();
    expect(harness.ingestCalls).toBe(1);
    expect(
      (await persistence.listEvents({ type: "providerHook.ingested" })).map((event) => event.event),
    ).toHaveLength(1);
    sqlite.close();
  });

  it("deduplicates harness report ids before duplicate persistence", async () => {
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createSqliteObserverPersistence({
      sqlite,
      clock,
      idFactory: ids(),
    });
    const eventBus = createObserverEventBus();
    const ingestion = createHarnessEventReportIngestion({
      persistence,
      eventBus,
      clock,
    });
    const report = harnessReport("report_dedupe_1");

    const first = await ingestion.ingest(report, { triggerReconcile: false });
    const second = await ingestion.ingest(report, { triggerReconcile: false });

    expect(first).toMatchObject({ status: "accepted", deduped: false });
    expect(second).toMatchObject({ status: "accepted", deduped: true });
    expect(
      (await persistence.listEvents({ type: "harness.eventReported" })).map((event) => event.event),
    ).toHaveLength(1);
    await expect(persistence.listProviderObservations()).resolves.toHaveLength(1);
    sqlite.close();
  });

  it("routes harness provider hook events through provider ingress and stores normalized observations", async () => {
    const clock = { now: () => new Date(now) };
    const harness = new RecordingHarnessProvider({ now });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [harness],
    });
    const { sqlite, persistence, eventBus, api } = createTestObserver({ config, providers, clock });
    const reconciled = nextObserverReconciled(eventBus);

    const receipt = await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_harness_1",
      provider: "fake-harness",
      kind: "harness",
      event: "run.updated",
      receivedAt: now,
      worktreeId: "wt_web_feature_auth",
      sessionId: "ses_web_feature_auth",
      payload: { state: "idle" },
    });

    expect(receipt).toMatchObject({ status: "ingested", reconciled: false });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await reconciled.close();
    expect(harness.ingestCalls).toBe(1);
    await expect(persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "fake-harness",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "run_hook_1",
          expiresAt: "2026-06-03T12:00:00.000Z",
          payload: expect.objectContaining({
            provider: "fake-harness",
            harnessRunId: "run_hook_1",
            status: expect.objectContaining({
              source: "harness_event",
              value: "idle",
            }),
          }),
        }),
      ]),
    );
    sqlite.close();
  });

  it("passes persisted worktree and terminal context to harness provider hook ingress", async () => {
    const clock = { now: () => new Date(now) };
    const harness = new ContextRecordingHarnessProvider({ now });
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [harness],
    });
    const { sqlite, persistence, eventBus, api } = createTestObserver({
      config: projectConfig,
      providers,
      clock,
    });
    const reconciled = nextObserverReconciled(eventBus);
    const worktree = createFakeWorktree({
      id: "wt_web_feature_auth",
      projectId: "web",
      branch: "feature/auth",
      path: "/tmp/station/web/feature-auth",
      now,
    });
    const terminal = createFakeTerminalTarget({
      id: "term_web_feature_auth",
      projectId: "web",
      worktreeId: "wt_web_feature_auth",
      sessionId: "ses_web_feature_auth",
      harnessRunId: "run_hook_1",
      now,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "fake-harness",
      },
    });
    await persistence.persistReconcileResult({
      projects: providerProjects,
      worktrees: [worktree],
      terminalTargets: [terminal],
      harnessRuns: [],
      observedAt: now,
    });

    await api.ingestProviderHookEvent({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_context_1",
      provider: "fake-harness",
      kind: "harness",
      event: "run.updated",
      receivedAt: now,
      payload: { state: "needs_attention" },
    });

    expect(harness.lastContext).toMatchObject({
      projects: [{ id: "web" }],
      worktrees: [{ id: "wt_web_feature_auth" }],
      terminalTargets: [{ id: "term_web_feature_auth" }],
    });
    await expect(reconciled.next).resolves.toMatchObject({
      value: { type: "observer.reconciled" },
    });
    await reconciled.close();
    sqlite.close();
  });
});

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [],
};

const providerProjects = [
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
];

const projectConfig: StationConfig = {
  ...config,
  projects: providerProjects,
};

function ids() {
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

function nextObserverReconciled(eventBus: ReturnType<typeof createObserverEventBus>) {
  const events = eventBus.subscribe({ type: "observer.reconciled" })[Symbol.asyncIterator]();
  return {
    next: events.next(),
    close: async () => {
      await events.return?.();
    },
  };
}

function harnessReport(reportId: string) {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider: "codex",
    kind: "harness" as const,
    eventType: "PreToolUse",
    observedAt: now,
    status: {
      value: "working" as const,
      confidence: "medium" as const,
      reason: "Codex is about to use Bash.",
      source: "harness_event" as const,
      updatedAt: now,
    },
    correlation: {
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      terminalTargetId: "tmux:station:@1:%2",
      cwd: "/tmp/station/web/task",
    },
    coalesceKey: "turn:turn_1:tool:Bash",
  };
}

function acceptedReportReceipt(
  reportId: string,
  provider: string,
  eventType: string,
): HarnessEventReportReceipt {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId,
    provider,
    eventType,
    accepted: true,
    status: "accepted",
    receivedAt: now,
    projected: false,
    scheduledReconcile: false,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

class RecordingHarnessProvider extends FakeHarnessProvider {
  ingestCalls = 0;

  constructor(options: ConstructorParameters<typeof FakeHarnessProvider>[0]) {
    super({
      ...options,
      runs: [
        createFakeHarnessRun({
          id: "run_hook_1",
          worktreeId: "wt_web_feature_auth",
          sessionId: "ses_web_feature_auth",
          state: "idle",
          now,
        }),
      ],
    });
  }

  override async ingestEvent() {
    this.ingestCalls += 1;
    return [
      {
        provider: this.id,
        harnessRunId: "run_hook_1",
        worktreeId: "wt_web_feature_auth",
        sessionId: "ses_web_feature_auth",
        rawEventType: "run.updated",
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

class ContextRecordingHarnessProvider extends FakeHarnessProvider {
  lastContext: Parameters<NonNullable<FakeHarnessProvider["ingestEvent"]>>[1] | undefined;

  override async ingestEvent(
    event: Parameters<NonNullable<FakeHarnessProvider["ingestEvent"]>>[0],
    context: Parameters<NonNullable<FakeHarnessProvider["ingestEvent"]>>[1],
  ) {
    this.lastContext = context;
    return super.ingestEvent(event, context);
  }
}
