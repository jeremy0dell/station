import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHookPayloadToHarnessEventReport, compactCodexHookPayload } from "@station/codex";
import type { StationConfig } from "@station/config";
import type { HarnessEventReport, HarnessEventReportReceipt } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import { FakeHarnessProvider, FakeTerminalProvider, FakeWorktreeProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import {
  fileExists,
  readHarnessEventReportSpoolRecord,
  readHookSpoolRecord,
  writeHarnessEventReportSpoolRecordFixture,
  writeHookSpoolRecordFixture,
  writeInvalidHookSpoolFile,
} from "../../../../tests/support/spool";
import {
  createCommandQueue,
  createFilesystemProviderIngressSpoolStore,
  createObserverApi,
  createObserverCore,
  createObserverEventBus,
  createProviderHookIngress,
  createSqliteObserverPersistence,
  drainProviderIngressSpool,
  type HarnessEventReportIngestion,
  openObserverSqlite,
  type ProviderHookIngress,
  ProviderRegistry,
  probeObserverSocket,
  providerIngressSpoolDir,
  startObserverServer,
} from "../../src/internal";

const now = "2026-05-20T12:00:00.000Z";

describe("observer hook spool drain", () => {
  it("drains valid spool files on reconcile and deletes only successful records", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    await writeHookSpoolRecordFixture({ spoolDir, spoolId: "spool_1" });
    const fixture = createFixture(spoolDir);

    await fixture.api.reconcile("manual");

    await expect(stat(join(spoolDir, "spool_1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const events = await fixture.persistence.listEvents();
    expect(events.map((event) => event.type)).toEqual([
      "providerHook.ingested",
      "providerHook.spoolDrained",
      "observer.reconciled",
    ]);
    expect(events[0]?.event).toMatchObject({ hookId: "spool_1" });
    fixture.sqlite.close();
  });

  it("keeps invalid spool files, continues valid records, and counts failures", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const invalidPath = await writeInvalidHookSpoolFile({ spoolDir, fileName: "bad.json" });
    const validPath = await writeHookSpoolRecordFixture({ spoolDir, spoolId: "spool_valid" });
    const fixture = createFixture(spoolDir);

    await fixture.api.reconcile("manual");

    await expect(fileExists(invalidPath)).resolves.toBe(true);
    await expect(fileExists(validPath)).resolves.toBe(false);
    const drainEvent = (await fixture.persistence.listEvents()).find(
      (event) => event.type === "providerHook.spoolDrained",
    );
    expect(drainEvent?.event).toMatchObject({
      type: "providerHook.spoolDrained",
      drained: 1,
      failed: 1,
    });
    fixture.sqlite.close();
  });

  it("leaves rejected spool records in place and publishes failed drain counts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const successPath = await writeHookSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_success",
      event: { event: "worktree.created" },
    });
    const rejectedPath = await writeHookSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_rejected",
      event: { event: "worktree.rejected" },
    });
    const fixture = createFixture(spoolDir);
    const drainEvents = fixture.eventBus
      .subscribe({ type: "providerHook.spoolDrained" })
      [Symbol.asyncIterator]();
    const nextDrainEvent = drainEvents.next();

    const result = await drainProviderIngressSpool({
      store: createFilesystemProviderIngressSpoolStore(spoolDir),
      persistence: fixture.persistence,
      eventBus: fixture.eventBus,
      clock: fixture.clock,
      ingest: async (event) => ({
        schemaVersion: STATION_SCHEMA_VERSION,
        hookId: `hook_${event.event}`,
        provider: event.provider,
        event: event.event,
        accepted: event.event !== "worktree.rejected",
        status: event.event === "worktree.rejected" ? "rejected" : "ingested",
        receivedAt: event.receivedAt,
        ...(event.event === "worktree.rejected"
          ? {
              error: {
                tag: "ProviderHookIngressError",
                code: "HOOK_INGESTION_FAILED",
                message: "Hook event was rejected safely.",
                provider: event.provider,
              },
            }
          : { reconciled: false }),
      }),
    });

    expect(result).toEqual({ scanned: 2, drained: 1, failed: 1 });
    await expect(fileExists(successPath)).resolves.toBe(false);
    await expect(fileExists(rejectedPath)).resolves.toBe(true);
    await expect(readHookSpoolRecord(spoolDir, "spool_rejected.json")).resolves.toMatchObject({
      attempts: 1,
      lastError: {
        code: "HOOK_INGESTION_FAILED",
      },
    });
    await expect(nextDrainEvent).resolves.toMatchObject({
      done: false,
      value: {
        type: "providerHook.spoolDrained",
        drained: 1,
        failed: 1,
      },
    });
    await drainEvents.return?.();
    fixture.sqlite.close();
  });

  it("removes spool records that are terminally ignored", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const spoolPath = await writeHookSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_ignored",
    });

    await expect(
      drainProviderIngressSpool({
        store: createFilesystemProviderIngressSpoolStore(spoolDir),
        clock: { now: () => new Date(now) },
        ingest: async (event) => ({
          schemaVersion: STATION_SCHEMA_VERSION,
          hookId: event.hookId ?? "spool_ignored",
          provider: event.provider,
          event: event.event,
          accepted: false,
          status: "ignored",
          receivedAt: event.receivedAt,
        }),
      }),
    ).resolves.toEqual({ scanned: 1, drained: 1, failed: 0 });
    await expect(fileExists(spoolPath)).resolves.toBe(false);
  });

  it("retries downstream processing after primary hook dedupe and unlinks only after completion", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const spoolPath = await writeHookSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_retry_processing",
      event: {
        provider: "fake-harness",
        kind: "harness",
        event: "run.updated",
        payload: { state: "idle" },
      },
    });
    const clock = { now: () => new Date(now) };
    const sqlite = openObserverSqlite({ clock });
    const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids() });
    let failProcessingOnce = true;
    const retryingPersistence = {
      ...persistence,
      recordProviderObservationsWithIngressDedupe: async (
        input: Parameters<typeof persistence.recordProviderObservationsWithIngressDedupe>[0],
      ) => {
        if (failProcessingOnce) {
          failProcessingOnce = false;
          throw new Error("forced downstream processing failure");
        }
        return persistence.recordProviderObservationsWithIngressDedupe(input);
      },
    };
    const providers = new ProviderRegistry({
      worktree: new FakeWorktreeProvider({ now }),
      terminal: new FakeTerminalProvider({ now }),
      harnesses: [new ReplayHarnessProvider({ now })],
    });
    const ingress = createProviderHookIngress({
      persistence: retryingPersistence,
      providers,
      clock,
    });
    const store = createFilesystemProviderIngressSpoolStore(spoolDir);

    await expect(
      drainProviderIngressSpool({ store, ingest: (event) => ingress.ingest(event), clock }),
    ).resolves.toEqual({ scanned: 1, drained: 0, failed: 1 });
    await expect(fileExists(spoolPath)).resolves.toBe(true);
    await expect(persistence.listEvents({ type: "providerHook.ingested" })).resolves.toHaveLength(
      1,
    );
    await expect(persistence.listProviderObservations()).resolves.toEqual([]);

    await expect(
      drainProviderIngressSpool({ store, ingest: (event) => ingress.ingest(event), clock }),
    ).resolves.toEqual({ scanned: 1, drained: 1, failed: 0 });
    await expect(fileExists(spoolPath)).resolves.toBe(false);
    await expect(persistence.listEvents({ type: "providerHook.ingested" })).resolves.toHaveLength(
      1,
    );
    await expect(persistence.listProviderObservations()).resolves.toEqual([
      expect.objectContaining({ entityKey: "run_spool_retry" }),
    ]);
    sqlite.close();
  });

  it("opens health while making startup completion wait for spool and queue work", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const spoolPath = await writeHookSpoolRecordFixture({ spoolDir, spoolId: "spool_startup" });
    const gate = deferred();
    const fixture = createFixture(spoolDir, {
      providerHookIngress: {
        ingest: async (event) => {
          await gate.promise;
          return {
            schemaVersion: STATION_SCHEMA_VERSION,
            hookId: event.hookId ?? "hook_startup",
            provider: event.provider,
            event: event.event,
            accepted: true,
            status: "ingested",
            receivedAt: event.receivedAt,
            reconciled: false,
          };
        },
      },
    });
    const { socketPath } = await createTempSocketPath();

    const serverPromise = startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });

    await waitFor(async () => (await probeObserverSocket(socketPath)) === "listening");
    await expect(fileExists(spoolPath)).resolves.toBe(true);
    gate.resolve();
    const server = await serverPromise;
    await expect(fileExists(spoolPath)).resolves.toBe(false);
    await server.close();
    fixture.sqlite.close();
  });

  it("keeps harness report spool files until durable startup processing completes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const report = codexHarnessReport("report_codex_startup_slow", "call_startup");
    const spoolPath = await writeHarnessEventReportSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_codex_report_startup_slow",
      report,
    });
    const gate = deferred();
    let processingStarted = false;
    const fixture = createFixture(spoolDir, {
      harnessEventReportIngestion: {
        ingest: async (input): Promise<HarnessEventReportReceipt> => {
          processingStarted = true;
          await gate.promise;
          return acceptedHarnessReportReceipt(input);
        },
      },
    });
    const { socketPath } = await createTempSocketPath();

    const serverPromise = startObserverServer({
      socketPath,
      api: fixture.api,
      clock: fixture.clock,
    });

    await waitFor(async () => processingStarted);
    await expect(fileExists(spoolPath)).resolves.toBe(true);
    gate.resolve();
    const server = await serverPromise;
    await expect(fileExists(spoolPath)).resolves.toBe(false);
    await server.close();
    fixture.sqlite.close();
  });

  it("keeps rejected harness report spool files in place", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const report = codexHarnessReport("report_codex_rejected", "call_rejected");
    const spoolPath = await writeHarnessEventReportSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_codex_report_rejected",
      report,
    });
    const fixture = createFixture(spoolDir, {
      harnessEventReportIngestion: {
        ingest: async (input): Promise<HarnessEventReportReceipt> => ({
          schemaVersion: STATION_SCHEMA_VERSION,
          reportId: input.reportId,
          provider: input.provider,
          eventType: input.eventType,
          accepted: false,
          status: "rejected",
          receivedAt: now,
          projected: false,
          scheduledReconcile: false,
          error: {
            tag: "HarnessEventReportIngestionError",
            code: "HARNESS_EVENT_REPORT_INGESTION_FAILED",
            message: "Rejected by test ingestion.",
            provider: input.provider,
          },
        }),
      },
    });

    await fixture.api.reconcile("manual");

    await expect(fileExists(spoolPath)).resolves.toBe(true);
    await expect(
      readHarnessEventReportSpoolRecord(spoolDir, "spool_codex_report_rejected.json"),
    ).resolves.toMatchObject({
      attempts: 1,
      lastError: {
        code: "HARNESS_EVENT_REPORT_INGESTION_FAILED",
      },
    });
    fixture.sqlite.close();
  });

  it("drains compacted Codex harness event report records without raw tool payloads", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-state-"));
    const spoolDir = providerIngressSpoolDir(stateDir);
    const rawCommand = "pnpm test --raw-output";
    const compacted = compactCodexHookPayload({
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "PreToolUse",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      turn_id: "turn_1",
      tool_name: "Bash",
      tool_input: { command: rawCommand },
      tool_use_id: "call_test",
      station_worktree_id: "wt_web_task",
      station_session_id: "ses_web_task",
      station_terminal_target_id: "tmux:station:@1:%2",
    });
    const spoolPath = await writeHarnessEventReportSpoolRecordFixture({
      spoolDir,
      spoolId: "spool_codex_report_compacted",
      report: codexHookPayloadToHarnessEventReport({
        reportId: "report_codex_compacted",
        observedAt: now,
        payload: compacted.payload,
        diagnostics: {
          payloadBytes: compacted.originalByteCount,
          compactedBytes: compacted.compactedByteCount,
          compacted: compacted.compacted,
          omittedFieldNames: compacted.omittedFieldNames,
        },
      }),
    });
    const fixture = createFixture(spoolDir);

    await fixture.api.reconcile("manual");

    await expect(fileExists(spoolPath)).resolves.toBe(false);
    await expect(fixture.persistence.listProviderObservations()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          providerType: "harness",
          entityKind: "harness_event",
          entityKey: "ses_web_task",
          payload: expect.objectContaining({
            provider: "codex",
            reportId: "report_codex_compacted",
            eventType: "PreToolUse",
            worktreeId: "wt_web_task",
            rawEventType: "PreToolUse",
            diagnostics: expect.objectContaining({
              compacted: true,
            }),
            status: expect.objectContaining({
              value: "working",
              source: "harness_event",
            }),
            providerData: expect.objectContaining({
              hookEventName: "PreToolUse",
              toolUseId: "call_test",
            }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(await fixture.persistence.listProviderObservations())).not.toContain(
      rawCommand,
    );
    fixture.sqlite.close();
  });
});

function createFixture(
  spoolDir: string,
  options: {
    providerHookIngress?: ProviderHookIngress;
    harnessEventReportIngestion?: HarnessEventReportIngestion;
  } = {},
) {
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
    clock,
  });
  const queue = createCommandQueue({ persistence, clock, idFactory: ids(), eventBus });
  const api = createObserverApi({
    core,
    persistence,
    persistenceHealth: persistence,
    commandQueue: queue,
    eventBus,
    ...(options.providerHookIngress === undefined
      ? {}
      : { providerHookIngress: options.providerHookIngress }),
    ...(options.harnessEventReportIngestion === undefined
      ? {}
      : { harnessEventReportIngestion: options.harnessEventReportIngestion }),
    hookSpoolDir: spoolDir,
    clock,
  });
  return { api, eventBus, persistence, sqlite, clock };
}

function acceptedHarnessReportReceipt(report: HarnessEventReport): HarnessEventReportReceipt {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: report.reportId,
    provider: report.provider,
    eventType: report.eventType,
    accepted: true,
    status: "accepted",
    receivedAt: now,
    projected: false,
    scheduledReconcile: false,
  };
}

function codexHarnessReport(reportId: string, toolUseId: string): HarnessEventReport {
  const compacted = compactCodexHookPayload({
    session_id: "codex_session_test",
    transcript_path: null,
    cwd: "/tmp/station/web/task",
    hook_event_name: "PreToolUse",
    model: "gpt-5.4-codex",
    permission_mode: "default",
    turn_id: "turn_1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    tool_use_id: toolUseId,
    station_worktree_id: "wt_web_task",
    station_session_id: "ses_web_task",
  });
  return codexHookPayloadToHarnessEventReport({
    reportId,
    observedAt: now,
    payload: compacted.payload,
    diagnostics: {
      payloadBytes: compacted.originalByteCount,
      compactedBytes: compacted.compactedByteCount,
      compacted: compacted.compacted,
      omittedFieldNames: compacted.omittedFieldNames,
    },
  });
}

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

class ReplayHarnessProvider extends FakeHarnessProvider {
  override async ingestEvent() {
    return [
      {
        provider: this.id,
        harnessRunId: "run_spool_retry",
        worktreeId: "wt_spool_retry",
        sessionId: "ses_spool_retry",
        status: {
          value: "idle" as const,
          confidence: "high" as const,
          reason: "Replay harness reported idle.",
          source: "harness_event" as const,
          updatedAt: now,
        },
        observedAt: now,
      },
    ];
  }
}
