import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import {
  createObserverService,
  createStationClientRuntime,
  type ObserverService,
} from "@station/client";
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
  NDJSON_TRANSPORT_LIMITS,
  type ObserverClient,
  ProtocolRequestSchema,
  protocolSuccessResponse,
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

  it("pins service operations to the accepted Observer build", async () => {
    const { socketPath } = await createTempSocketPath();
    const actualBuildVersion = `0.7.0+station.${"a".repeat(64)}`;
    const expectedBuildVersion = `0.7.0+station.${"b".repeat(64)}`;
    let dispatchCalls = 0;
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        health: async () => ({ ...fakeHealth(), version: actualBuildVersion }),
        dispatch: async () => {
          dispatchCalls += 1;
          return { commandId: "cmd_wrong_build", accepted: true, status: "accepted" };
        },
      }),
    });
    const service = createObserverService({
      socketPath,
      expectedBuildVersion,
      requestId: ids("build-pin"),
    });

    try {
      await expect(
        service.dispatch({ type: "observer.reconcile", payload: { reason: "must-not-run" } }),
      ).rejects.toMatchObject({ code: "OBSERVER_BUILD_MISMATCH" });
      expect(dispatchCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("requires an accepted build selector for socket-backed client runtimes", () => {
    expect(() =>
      createStationClientRuntime({ socketPath: "/tmp/station-test.sock" } as never),
    ).toThrow("socketPath requires an accepted Observer build selector");
  });

  it("forwards the accepted build selector from a socket-backed client runtime", async () => {
    const { socketPath } = await createTempSocketPath();
    const actualBuildVersion = `0.7.0+station.${"a".repeat(64)}`;
    const expectedBuildVersion = `0.7.0+station.${"b".repeat(64)}`;
    let snapshotCalls = 0;
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        health: async () => ({ ...fakeHealth(), version: actualBuildVersion }),
        getSnapshot: async () => {
          snapshotCalls += 1;
          return createCommandSnapshot("idle");
        },
      }),
    });
    const runtime = createStationClientRuntime({
      socketPath,
      expectedBuildVersion,
      requestTimeoutMs: 500,
    });

    try {
      await expect(runtime.service.loadSnapshot()).rejects.toMatchObject({
        code: "OBSERVER_BUILD_MISMATCH",
      });
      expect(snapshotCalls).toBe(0);
    } finally {
      await runtime.stop();
      await server.close();
    }
  });

  it("shows a transport overflow as display-only until snapshot resync converges", async () => {
    const { socketPath } = await createTempSocketPath();
    const initialSnapshot = createCommandSnapshot("idle");
    const recoveredSnapshot = createCommandSnapshot("idle", { dirty: true });
    const event: StationEvent = {
      type: "command.accepted",
      commandId: "cmd_transport_overflow",
      command: {
        type: "observer.reconcile",
        payload: { reason: "x".repeat(4_000) },
      },
    };
    let subscriptionCalls = 0;
    let firstSubscriptionClosed = false;
    let snapshotCalls = 0;
    let releaseFirstPull: () => void = () => undefined;
    let releaseSnapshot: () => void = () => undefined;
    const firstPull = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    const snapshotLoad = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = ProtocolRequestSchema.parse(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          if (request.method === "events.subscribe") {
            subscriptionCalls += 1;
            writeFrame(
              socket,
              protocolSuccessResponse(request.id, "events.subscribe", { subscribed: true }),
            );
            if (subscriptionCalls === 1) {
              socket.once("close", () => {
                firstSubscriptionClosed = true;
              });
              const envelope = { schemaVersion: STATION_SCHEMA_VERSION, event };
              for (let index = 0; index < 2_048; index += 1) writeFrame(socket, envelope);
            }
          } else if (request.method === "snapshot.get") {
            snapshotCalls += 1;
            void snapshotLoad.then(() => {
              writeFrame(
                socket,
                protocolSuccessResponse(request.id, "snapshot.get", recoveredSnapshot),
              );
            });
          }
        }
      });
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    server.listen(socketPath);
    await once(server, "listening");
    const transportService = createObserverService({
      socketPath,
      requestId: ids("runtime-overflow"),
    });
    let delayFirstEvent = true;
    const service: ObserverService = {
      ...transportService,
      subscribeEvents: () => {
        const events = transportService.subscribeEvents();
        if (!delayFirstEvent) return events;
        delayFirstEvent = false;
        return delayFirstEventDelivery(events, firstPull);
      },
    };
    const runtime = createStationClientRuntime({
      service,
      initialSnapshot,
      reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    });

    try {
      runtime.start();
      await waitFor(() => firstSubscriptionClosed, 3_000);
      releaseFirstPull();

      await waitFor(() => runtime.getState().connection.state === "displayOnly", 3_000);
      await waitFor(() => subscriptionCalls >= 2 && snapshotCalls === 1, 3_000);
      const recovering = runtime.getState().connection;
      expect(recovering).toMatchObject({
        state: "displayOnly",
        lastError: { code: "PROTOCOL_TRANSPORT_OVERFLOW" },
      });
      await waitFor(() => runtime.diagnostics().transport.overflowCount === 1, 3_000);
      expect(runtime.diagnostics()).toMatchObject({
        resubscriptionCount: 1,
        transport: {
          inboundQueueDepth: 0,
          inboundQueueBytes: 0,
          inboundHighWaterDepth: NDJSON_TRANSPORT_LIMITS.maxQueuedFrames,
          overflowCount: 1,
          closeCount: 1,
          lastOverflowReason: "queued-frames",
        },
      });
      expect(runtime.getState().snapshot?.rows[0]?.worktree.dirty).toBe(false);

      releaseSnapshot();
      await waitFor(() => runtime.getState().connection.state === "connected", 3_000);
      expect(runtime.getState().snapshot?.rows[0]?.worktree.dirty).toBe(true);
    } finally {
      releaseFirstPull();
      releaseSnapshot();
      await runtime.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aggregates discarded connection diagnostics across protocol resubscriptions", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({ socketPath, api: fakeApi() });
    const runtime = createStationClientRuntime({
      socketPath,
      expectedBuildVersion: "0.0.0",
      initialSnapshot: createCommandSnapshot("idle"),
      reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    });

    try {
      runtime.start();
      await waitFor(
        () =>
          runtime.diagnostics().resubscriptionCount >= 1 &&
          runtime.diagnostics().transport.closeCount >= 1,
        3_000,
      );
      expect(runtime.diagnostics()).toMatchObject({
        transport: {
          inboundQueueDepth: 0,
          inboundQueueBytes: 0,
          overflowCount: 0,
        },
      });
      expect(runtime.diagnostics().transport.inboundHighWaterDepth).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.stop();
      await server.close();
    }
  });

  it("prepares external launches and reports external exits through the protocol", async () => {
    const { socketPath } = await createTempSocketPath();
    const prepared: Array<{ projectId: string; worktreeId: string; title?: string }> = [];
    const exited: Array<{ terminalTargetId: string; expectedSessionId?: string }> = [];
    const server = await startProtocolServer({
      socketPath,
      api: fakeApi({
        prepareExternalLaunch: async (params) => {
          prepared.push(params);
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
            attachment: {
              kind: "managed-terminal",
              terminalTargetId: `native:${params.worktreeId}`,
            },
          };
        },
        reportExternalExit: async (params) => {
          exited.push(params);
          return { acknowledged: true, terminalTargetId: params.terminalTargetId };
        },
      }),
    });
    const service = createObserverService({ socketPath, requestId: ids("ext") });

    await expect(
      service.prepareExternalLaunch({
        projectId: "web",
        worktreeId: "wt_web_feature",
        title: "Hexagonal PT 12",
      }),
    ).resolves.toMatchObject({
      kind: "prepared",
      sessionId: "ses_external_1",
      terminalTargetId: "native:wt_web_feature",
      launchPlan: { provider: "claude", env: { STATION_SESSION_ID: "ses_external_1" } },
      attachment: {
        kind: "managed-terminal",
        terminalTargetId: "native:wt_web_feature",
      },
    });
    await expect(
      service.reportExternalExit({
        terminalTargetId: "native:wt_web_feature",
        expectedSessionId: "ses_external_1",
      }),
    ).resolves.toEqual({ acknowledged: true, terminalTargetId: "native:wt_web_feature" });

    expect(prepared).toEqual([
      { projectId: "web", worktreeId: "wt_web_feature", title: "Hexagonal PT 12" },
    ]);
    expect(exited).toEqual([
      {
        terminalTargetId: "native:wt_web_feature",
        expectedSessionId: "ses_external_1",
      },
    ]);

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
      client: fakeClient({
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => new Promise<IteratorResult<StationEvent>>(() => undefined),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          }),
        }),
      }),
    });

    const iterator = service.subscribeEvents()[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(returned).toBe(true);
  });

  it("maps succeeded terminal command records", async () => {
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async (commandId) =>
          resultCommandRecord(commandId) as TerminalCommandRecord,
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_done")).resolves.toEqual({
      status: "succeeded",
      commandId: "cmd_done",
      result: {
        type: "worktree.create",
        projectId: "web",
        worktreeId: "wt_client_result",
      },
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

  it("preserves an Observer build mismatch while waiting for command completion", async () => {
    const mismatch = {
      tag: "ProtocolError" as const,
      code: "OBSERVER_BUILD_MISMATCH",
      message: "Observer build mismatch: expected caller-build, received incumbent-build.",
      hint: "Close and relaunch this client.",
    };
    const service = createObserverService({
      client: fakeClient({
        waitForCommand: async () => {
          throw mismatch;
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_replaced")).rejects.toEqual(mismatch);
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
      status: "accepted",
      receivedAt: event.receivedAt,
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
      })),
    getSessionRecoveryReadiness:
      overrides.getSessionRecoveryReadiness ??
      (async () => ({ resumeEnabled: true, harnesses: [] })),
    getSessionRecoveryInventory:
      overrides.getSessionRecoveryInventory ??
      (async () => ({ schemaVersion: 1, sessions: [], recoveryHandles: [] })),
    getSessionRecoveryAssessment:
      overrides.getSessionRecoveryAssessment ??
      (async () => ({
        schemaVersion: 1,
        inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
        resumeEnabled: true,
        providerCapabilities: [],
        sessions: [],
      })),
    getCurrentSessionContext:
      overrides.getCurrentSessionContext ??
      (async () => ({
        source: {
          provider: "fake-terminal",
          targetId: "target_1",
          generation: "generation_1",
          authorityId: "authority_1",
          expiresAt: fixtureNow,
        },
        presentation: "presented",
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
    prepareWorktreeRemoval:
      overrides.prepareWorktreeRemoval ??
      (async (params) => ({
        reservationId: "reservation_client_1",
        projectId: params.projectId ?? "project",
        worktreeId: params.worktreeId,
        externalTerminalExitRequired: false,
      })),
    cancelWorktreeRemoval: overrides.cancelWorktreeRemoval ?? (async () => ({ cancelled: true })),
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
  const snapshot = createCommandSnapshot("idle");
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    status: "healthy",
    generatedAt: fixtureNow,
    checks: [],
    observer: fakeHealth(),
    config: { projectCount: snapshot.projects.length, diagnostics: [] },
    providers: {},
    snapshot,
    logs: { paths: [], recent: [] },
    localState: {
      stateDir: "/tmp/station",
      totalBytes: 0,
      limitBytes: 1,
      overLimit: false,
      entries: [],
    },
    retention: {
      maxDays: 1,
      maxTotalMb: 1,
      maxFileMb: 1,
      maxFilesPerComponent: 1,
      components: {
        observerMaxMb: 1,
        cliMaxMb: 1,
        tuiMaxMb: 1,
        hookRunnerMaxMb: 1,
        providerMaxMb: 1,
      },
      sqlite: {
        eventsMaxDays: 1,
        commandsMaxDays: 1,
        errorsMaxDays: 1,
        providerObservationsMaxDays: 1,
      },
      debugBundles: { maxBundles: 1, maxDays: 1 },
      hookSpool: { deliveredDeleteImmediately: true, failedMaxDays: 1, failedMaxItems: 1 },
    },
    recentErrors: [],
    debugBundle: { available: true, diagnosticsDir: "/tmp/station/diagnostics" },
  };
}

function fakeDiagnostics(): DiagnosticSnapshot {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    collectedAt: fixtureNow,
    observerHealth: fakeHealth(),
    snapshot: createCommandSnapshot("idle"),
    providerHealth: {},
    commands: [],
    events: [],
    errors: [],
    logs: [],
  };
}

async function* stream(events: StationEvent[]): AsyncIterable<StationEvent> {
  for (const event of events) {
    yield event;
  }
}

function delayFirstEventDelivery(
  events: AsyncIterable<StationEvent>,
  release: Promise<void>,
): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.asyncIterator]();
      let first = true;
      return {
        next: async () => {
          const result = await iterator.next();
          if (first) {
            first = false;
            await release;
          }
          return result;
        },
        return: async () => {
          await iterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function writeFrame(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
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
      status: "accepted",
      receivedAt: event.receivedAt,
    }),
    reportHarnessEvent: async (report: HarnessEventReport) => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: report.reportId,
      provider: report.provider,
      eventType: report.eventType,
      accepted: true,
      status: "accepted",
      receivedAt: report.observedAt,
    }),
    getSessionRecoveryReadiness: async () => ({ resumeEnabled: true, harnesses: [] }),
    getSessionRecoveryInventory: async () => ({
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [],
    }),
    getSessionRecoveryAssessment: async () => ({
      schemaVersion: 1,
      inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
      resumeEnabled: true,
      providerCapabilities: [],
      sessions: [],
    }),
    prepareExternalLaunch: async (params) => ({
      kind: "existing-session",
      sessionId: `ses_${params.worktreeId}`,
      harnessProvider: "fake-harness",
    }),
    reportExternalExit: async (params) => ({
      acknowledged: true,
      terminalTargetId: params.terminalTargetId,
    }),
    prepareWorktreeRemoval: async (params) => ({
      reservationId: "reservation_client_1",
      projectId: params.projectId ?? "project",
      worktreeId: params.worktreeId,
      externalTerminalExitRequired: false,
    }),
    cancelWorktreeRemoval: async () => ({ cancelled: true }),
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

function resultCommandRecord(commandId: CommandId): CommandRecord {
  return {
    id: commandId,
    type: "worktree.create",
    command: {
      type: "worktree.create",
      payload: { projectId: "web", branch: "client-result" },
    },
    status: "succeeded",
    createdAt: fixtureNow,
    startedAt: fixtureNow,
    finishedAt: fixtureNow,
    result: {
      type: "worktree.create",
      projectId: "web",
      worktreeId: "wt_client_result",
    },
  };
}

function ids(prefix: string): () => string {
  let id = 0;
  return () => `${prefix}_${++id}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer client state.");
    await delay(5);
  }
}
