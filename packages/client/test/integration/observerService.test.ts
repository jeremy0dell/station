import { createObserverService } from "@station/client";
import type {
  CommandId,
  CommandRecord,
  DiagnosticSnapshot,
  DoctorReport,
  HarnessEventReport,
  HarnessEventReportReceipt,
  ObserverApi,
  ObserverHealth,
  ObserverStopReceipt,
  ProviderHookEvent,
  ProviderHookReceipt,
  ReconcileReceipt,
  StationCommand,
  StationEvent,
  StationSnapshot,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  listenUnixSocket,
  type ObserverClient,
  startProtocolServer,
  type TerminalCommandRecord,
} from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import { createCommandSnapshot, fixtureNow } from "../support/snapshots.js";

describe("observer client service", () => {
  it("loads snapshots and dispatches commands through the observer protocol", async () => {
    const { socketPath } = await createTempSocketPath();
    const snapshot = createCommandSnapshot("idle");
    const commands: StationCommand[] = [];
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        snapshot,
        dispatch: async (command) => {
          commands.push(command);
          return { commandId: "cmd_tui_1", accepted: true, status: "accepted" };
        },
      }),
    });
    const service = createObserverService({ socketPath, requestId: ids("tui") });

    await expect(service.loadSnapshot()).resolves.toMatchObject({
      counts: { worktrees: 1 },
    });
    await expect(
      service.dispatch({ type: "observer.reconcile", payload: { reason: "tui-test" } }),
    ).resolves.toMatchObject({ commandId: "cmd_tui_1" });
    expect(commands).toHaveLength(1);

    await server.close();
  });

  it("prepares external launches and reports external exits through the protocol", async () => {
    const { socketPath } = await createTempSocketPath();
    const prepared: Array<{ projectId: string; worktreeId: string }> = [];
    const exited: string[] = [];
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        prepareExternalLaunch: async (params) => {
          prepared.push({ projectId: params.projectId, worktreeId: params.worktreeId });
          return {
            kind: "prepared",
            sessionId: "ses_external_1",
            terminalTargetId: `native:${params.worktreeId}`,
            launchPlan: {
              provider: "claude",
              command: "claude",
              args: [],
              cwd: "/tmp/station/web/feature",
              env: { STATION_SESSION_ID: "ses_external_1" },
              mode: "interactive",
            },
          };
        },
        reportExternalExit: async (params) => {
          exited.push(params.terminalTargetId);
          return { acknowledged: true, terminalTargetId: params.terminalTargetId };
        },
      }),
    });
    const service = createObserverService({ socketPath, requestId: ids("ext") });

    await expect(
      service.prepareExternalLaunch({ projectId: "web", worktreeId: "wt_web_feature" }),
    ).resolves.toMatchObject({
      kind: "prepared",
      sessionId: "ses_external_1",
      terminalTargetId: "native:wt_web_feature",
      launchPlan: { provider: "claude", env: { STATION_SESSION_ID: "ses_external_1" } },
    });
    await expect(
      service.reportExternalExit({ terminalTargetId: "native:wt_web_feature" }),
    ).resolves.toEqual({ acknowledged: true, terminalTargetId: "native:wt_web_feature" });

    expect(prepared).toEqual([{ projectId: "web", worktreeId: "wt_web_feature" }]);
    expect(exited).toEqual(["native:wt_web_feature"]);

    await server.close();
  });

  it("maps protocol SafeErrors without dropping diagnostic IDs", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        dispatch: async () => {
          throw {
            tag: "TerminalProviderError",
            code: "TERMINAL_TARGET_MISSING",
            message: "The terminal target for this worktree no longer exists.",
            diagnosticId: "diag_terminal_missing",
            traceId: "trc_terminal_missing",
          };
        },
      }),
    });
    const service = createObserverService({ socketPath, requestId: ids("err") });

    await expect(
      service.dispatch({ type: "observer.reconcile", payload: { reason: "safe-error-test" } }),
    ).rejects.toMatchObject({
      code: "TERMINAL_TARGET_MISSING",
      diagnosticId: "diag_terminal_missing",
    });

    await server.close();
  });

  it("times out safely when the observer does not answer", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: () => undefined,
    });
    const service = createObserverService({
      socketPath,
      timeoutMs: 10,
      requestId: ids("timeout"),
    });

    try {
      await expect(service.loadSnapshot()).rejects.toMatchObject({
        tag: "TimeoutError",
      });
    } finally {
      await server.close();
    }
  });

  it("uses a separate timeout for observer reconciles", async () => {
    const { socketPath } = await createTempSocketPath();
    const snapshot = createCommandSnapshot("idle");
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        snapshot,
        reconcile: async (): Promise<ReconcileReceipt> => {
          await delay(25);
          return {
            schemaVersion: STATION_SCHEMA_VERSION,
            reason: "slow-refresh",
            reconciledAt: fixtureNow,
            snapshot,
          };
        },
      }),
    });
    const service = createObserverService({
      socketPath,
      timeoutMs: 10,
      reconcileTimeoutMs: 100,
      requestId: ids("reconcile-timeout"),
    });

    try {
      await expect(service.reconcile("slow-refresh")).resolves.toMatchObject({
        counts: { worktrees: 1 },
      });
    } finally {
      await server.close();
    }
  });

  it("returns the underlying subscription iterator for cleanup", async () => {
    let returned = false;
    const service = createObserverService({
      client: {
        health: async () => fakeHealth(),
        stop: async () => ({
          schemaVersion: STATION_SCHEMA_VERSION,
          stopped: true,
          at: fixtureNow,
        }),
        getSnapshot: async () => createCommandSnapshot("idle"),
        dispatch: async () => ({ commandId: "cmd_1", accepted: true, status: "accepted" }),
        getCommand: async () => undefined,
        waitForCommand: async () => commandRecord("cmd_1", "succeeded") as TerminalCommandRecord,
        reconcile: async () => ({
          schemaVersion: STATION_SCHEMA_VERSION,
          reason: "test",
          reconciledAt: fixtureNow,
          snapshot: createCommandSnapshot("idle"),
        }),
        ingestProviderHookEvent: async (event: ProviderHookEvent) => ({
          schemaVersion: STATION_SCHEMA_VERSION,
          hookId: "hook_1",
          provider: event.provider,
          event: event.event,
          accepted: true,
          status: "ingested",
          receivedAt: event.receivedAt,
          reconciled: true,
        }),
        runDoctor: async () => fakeDoctor(),
        collectDiagnostics: async () => fakeDiagnostics(),
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => new Promise<IteratorResult<StationEvent>>(() => undefined),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
    });

    const iterator = service.subscribeEvents()[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(returned).toBe(true);
  });

  it("maps succeeded terminal command records", async () => {
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async (commandId) =>
          commandRecord(commandId, "succeeded") as TerminalCommandRecord,
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_done")).resolves.toEqual({
      status: "succeeded",
      commandId: "cmd_done",
    });
  });

  it("uses a longer default timeout for command completion waits than request calls", async () => {
    let observedTimeoutMs: number | undefined;
    const service = createObserverService({
      timeoutMs: 10,
      client: fakeClient({
        waitForCommand: async (commandId, options) => {
          observedTimeoutMs = options?.timeoutMs;
          return commandRecord(commandId, "succeeded") as TerminalCommandRecord;
        },
      }),
    });

    await service.waitForCommandCompletion("cmd_done");

    expect(observedTimeoutMs).toBe(35_000);
  });

  it("maps failed terminal command records and preserves SafeError diagnostic context", async () => {
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async (commandId) =>
          commandRecord(commandId, "failed") as TerminalCommandRecord,
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_failed")).resolves.toEqual({
      status: "failed",
      commandId: "cmd_failed",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_STALE",
        message: "The terminal target is stale.",
        diagnosticId: "diag_terminal_stale",
      },
    });
  });

  it("maps failed terminal command records without error payloads to a client-safe error", async () => {
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async (commandId) => {
          const record = commandRecord(commandId, "failed");
          delete record.error;
          return record as TerminalCommandRecord;
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_missing_error")).resolves.toEqual({
      status: "failed",
      commandId: "cmd_missing_error",
      error: {
        tag: "ClientObserverError",
        code: "CLIENT_COMMAND_FAILED_WITHOUT_ERROR",
        message: "The observer command failed without an error payload.",
        commandId: "cmd_missing_error",
      },
    });
  });

  it("wraps protocol wait failures in client command wait errors", async () => {
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async () => {
          throw {
            tag: "ProtocolError",
            code: "PROTOCOL_COMMAND_EVENT_STREAM_CLOSED",
            message: "Observer event stream closed before command completion.",
          };
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_closed")).rejects.toMatchObject({
      code: "CLIENT_COMMAND_WAIT_FAILED",
    });
  });

  it("times out while waiting for command completion", async () => {
    const service = createObserverService({
      timeoutMs: 10,
      client: fakeClient({
        waitForCommand: async () => {
          throw {
            tag: "TimeoutError",
            code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
            message: "Observer command did not finish before the timeout.",
          };
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_hung")).rejects.toMatchObject({
      code: "CLIENT_COMMAND_WAIT_TIMEOUT",
    });
  });
});

function fakeApi(
  overrides: Partial<ObserverApi> & { snapshot?: StationSnapshot } = {},
): ObserverApi {
  const snapshot = overrides.snapshot ?? createCommandSnapshot("idle");
  const ingestProviderHookEvent =
    overrides.ingestProviderHookEvent ??
    (async (event: ProviderHookEvent): Promise<ProviderHookReceipt> => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_1",
      provider: event.provider,
      event: event.event,
      accepted: true,
      status: "ingested",
      receivedAt: event.receivedAt,
      reconciled: true,
    }));
  return {
    health: overrides.health ?? (async () => fakeHealth()),
    stop:
      overrides.stop ??
      (async (): Promise<ObserverStopReceipt> => ({
        schemaVersion: STATION_SCHEMA_VERSION,
        stopped: true,
        at: fixtureNow,
      })),
    getSnapshot: overrides.getSnapshot ?? (async () => snapshot),
    subscribe: overrides.subscribe ?? (() => stream([])),
    dispatch:
      overrides.dispatch ??
      (async () => ({ commandId: "cmd_1", accepted: true, status: "accepted" })),
    getCommand: overrides.getCommand ?? (async () => undefined),
    reconcile:
      overrides.reconcile ??
      (async (): Promise<ReconcileReceipt> => ({
        schemaVersion: STATION_SCHEMA_VERSION,
        reason: "test",
        reconciledAt: fixtureNow,
        snapshot,
      })),
    ingestProviderHookEvent,
    reportHarnessEvent:
      overrides.reportHarnessEvent ??
      (async (report: HarnessEventReport): Promise<HarnessEventReportReceipt> => ({
        schemaVersion: STATION_SCHEMA_VERSION,
        reportId: report.reportId,
        provider: report.provider,
        eventType: report.eventType,
        accepted: true,
        status: "accepted",
        receivedAt: report.observedAt,
        projected: false,
        scheduledReconcile: true,
      })),
    prepareExternalLaunch:
      overrides.prepareExternalLaunch ??
      (async (params) => ({
        kind: "existing-session",
        sessionId: `ses_${params.worktreeId}`,
        harnessProvider: "fake-harness",
      })),
    reportExternalExit:
      overrides.reportExternalExit ??
      (async (params) => ({ acknowledged: true, terminalTargetId: params.terminalTargetId })),
    runDoctor: overrides.runDoctor ?? (async () => fakeDoctor()),
    collectDiagnostics: overrides.collectDiagnostics ?? (async () => fakeDiagnostics()),
  };
}

function fakeHealth(): ObserverHealth {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    pid: 4242,
    startedAt: fixtureNow,
    version: "0.0.0",
  };
}

function fakeDoctor(): DoctorReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    generatedAt: fixtureNow,
    checks: [],
  };
}

function fakeDiagnostics(): DiagnosticSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    collectedAt: fixtureNow,
    commands: [],
    events: [],
    errors: [],
    logs: [],
    redaction: {
      policyVersion: "test",
      redactedFields: [],
      redactedValues: 0,
      suspiciousPatterns: [],
    },
  };
}

async function* stream(events: StationEvent[]): AsyncIterable<StationEvent> {
  for (const event of events) {
    yield event;
  }
}

function fakeClient(overrides: Partial<ObserverClient>): ObserverClient {
  return {
    health: async () => fakeHealth(),
    stop: async () => ({ schemaVersion: STATION_SCHEMA_VERSION, stopped: true, at: fixtureNow }),
    getSnapshot: async () => createCommandSnapshot("idle"),
    dispatch: async () => ({ commandId: "cmd_1", accepted: true, status: "accepted" }),
    getCommand: async () => undefined,
    waitForCommand: async (commandId) =>
      commandRecord(commandId, "succeeded") as TerminalCommandRecord,
    reconcile: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason: "test",
      reconciledAt: fixtureNow,
      snapshot: createCommandSnapshot("idle"),
    }),
    ingestProviderHookEvent: async (event: ProviderHookEvent) => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      hookId: "hook_1",
      provider: event.provider,
      event: event.event,
      accepted: true,
      status: "ingested",
      receivedAt: event.receivedAt,
      reconciled: true,
    }),
    reportHarnessEvent: async (report: HarnessEventReport) => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: report.reportId,
      provider: report.provider,
      eventType: report.eventType,
      accepted: true,
      status: "accepted",
      receivedAt: report.observedAt,
      projected: false,
      scheduledReconcile: true,
    }),
    runDoctor: async () => fakeDoctor(),
    collectDiagnostics: async () => fakeDiagnostics(),
    subscribe: () => stream([]),
    ...overrides,
  };
}

function commandRecord(commandId: CommandId, status: CommandRecord["status"]): CommandRecord {
  const record: CommandRecord = {
    id: commandId,
    type: "terminal.focus",
    command: {
      type: "terminal.focus",
      payload: {
        sessionId: "ses_wt_web_idle",
      },
    },
    status,
    createdAt: fixtureNow,
  };
  if (status === "started" || status === "succeeded" || status === "failed") {
    record.startedAt = fixtureNow;
  }
  if (status === "succeeded" || status === "failed") {
    record.finishedAt = fixtureNow;
  }
  if (status === "failed") {
    record.error = {
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_STALE",
      message: "The terminal target is stale.",
      diagnosticId: "diag_terminal_stale",
    };
  }
  return record;
}

function ids(prefix: string): () => string {
  let id = 0;
  return () => `${prefix}_${++id}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
