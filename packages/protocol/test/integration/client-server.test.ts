import type {
  CommandRecord,
  HarnessEventReport,
  ProviderHookEvent,
  SafeError,
  StationCommand,
  TerminalCallerContextRequest,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  connectUnixSocket,
  createObserverClient,
  listenUnixSocket,
  ProtocolRequestSchema,
  protocolSuccessResponse,
  startProtocolServer,
  withExactObserverLifecycleSession,
} from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import { createFakeObserverApi, emptySnapshot, ids, protocolTestNow } from "../support/fixtures.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("protocol client/server", () => {
  it("routes health, recovery, current session, snapshot, dispatch, get, reconcile, and hook ingestion over a socket", async () => {
    const { socketPath } = await createTempSocketPath();
    const commands = new Map<string, CommandRecord>();
    const currentCallers: TerminalCallerContextRequest[] = [];
    const snapshot = emptySnapshot();
    const snapshotOptions: Array<{ includeDebug?: boolean } | undefined> = [];
    const debugSnapshot = {
      ...snapshot,
      debug: {
        terminal: {
          reconciledAt: protocolTestNow,
          providerReads: [],
          targets: [],
        },
      },
    };
    const api = createFakeObserverApi({
      snapshot,
      getSnapshot: async (options) => {
        snapshotOptions.push(options);
        return options?.includeDebug === true ? debugSnapshot : snapshot;
      },
      getSessionRecoveryInventory: async () => ({
        schemaVersion: 1,
        sessions: [
          {
            id: "session-protocol",
            projectId: "web",
            worktreeId: "worktree-protocol",
            lifecycle: "ended",
            createdAt: protocolTestNow,
            lastSeenAt: protocolTestNow,
          },
        ],
        recoveryHandles: [
          {
            id: "handle-protocol",
            provider: "codex",
            projectId: "different-project",
            worktreeId: "different-worktree",
            targetKind: "session-file",
            observedAt: protocolTestNow,
            lastSeenAt: protocolTestNow,
          },
        ],
      }),
      getSessionRecoveryAssessment: async () => ({
        schemaVersion: 1,
        inventory: {
          schemaVersion: 1,
          sessions: [
            {
              id: "session-protocol",
              projectId: "web",
              worktreeId: "worktree-protocol",
              lifecycle: "ended",
              createdAt: protocolTestNow,
              lastSeenAt: protocolTestNow,
            },
          ],
          recoveryHandles: [],
        },
        resumeEnabled: false,
        providerCapabilities: [],
        sessions: [
          {
            sessionId: "session-protocol",
            projectId: "web",
            worktreeId: "worktree-protocol",
            lifecycle: "ended",
            disposition: "not-applicable",
            reasons: ["station_session_ended"],
            handleResolution: {
              kind: "none",
              eligibleHandleCount: 0,
              rejectedHandleCount: 0,
              reasons: ["no_recovery_handles", "station_session_ended"],
            },
          },
        ],
      }),
      dispatch: async (command) => {
        const record: CommandRecord = {
          id: "cmd_1",
          type: command.type,
          command,
          status: "accepted",
          createdAt: protocolTestNow,
        };
        commands.set(record.id, record);
        return { commandId: record.id, accepted: true, status: "accepted" };
      },
      getCommand: async (commandId) => commands.get(commandId),
      getCurrentSessionContext: async (caller) => {
        currentCallers.push(caller);
        return {
          source: {
            provider: "tmux",
            targetId: "tmux:generation:$1:@2:%3",
            generation: "generation",
            authorityId: "authority",
            expiresAt: protocolTestNow,
          },
          presentation: "presented",
        };
      },
    });
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("req") });

    await expect(client.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      schemaVersion: STATION_SCHEMA_VERSION,
      counts: { projects: 0 },
    });
    await expect(client.getSnapshot({ includeDebug: true })).resolves.toMatchObject({
      debug: { terminal: { reconciledAt: protocolTestNow, providerReads: [], targets: [] } },
    });
    expect(snapshotOptions).toEqual([undefined, { includeDebug: true }]);
    await expect(client.getSessionRecoveryReadiness()).resolves.toEqual({
      resumeEnabled: true,
      canonicalTitleImport: true,
      managedTerminal: { provider: "native", canLaunchProcessPersistently: true },
      harnesses: [],
    });
    await expect(client.getSessionRecoveryInventory()).resolves.toEqual({
      schemaVersion: 1,
      sessions: [
        {
          id: "session-protocol",
          projectId: "web",
          worktreeId: "worktree-protocol",
          lifecycle: "ended",
          createdAt: protocolTestNow,
          lastSeenAt: protocolTestNow,
        },
      ],
      recoveryHandles: [
        {
          id: "handle-protocol",
          provider: "codex",
          projectId: "different-project",
          worktreeId: "different-worktree",
          targetKind: "session-file",
          observedAt: protocolTestNow,
          lastSeenAt: protocolTestNow,
        },
      ],
    });
    await expect(client.getSessionRecoveryAssessment()).resolves.toMatchObject({
      schemaVersion: 1,
      resumeEnabled: false,
      sessions: [
        {
          sessionId: "session-protocol",
          disposition: "not-applicable",
          reasons: ["station_session_ended"],
        },
      ],
    });
    const caller: TerminalCallerContextRequest = {
      process: { pid: 4321, startToken: "process-start" },
      claims: { TMUX: "/tmp/tmux.sock,123,0", TMUX_PANE: "%3" },
    };
    await expect(client.getCurrentSessionContext(caller)).resolves.toMatchObject({
      source: { provider: "tmux", authorityId: "authority" },
      presentation: "presented",
    });
    expect(currentCallers).toEqual([caller]);

    const command: StationCommand = {
      type: "worktree.create",
      payload: {
        projectId: "web",
        branch: "feature/protocol-test",
        launchHarness: "codex",
      },
    };
    await expect(client.dispatch(command)).resolves.toEqual({
      commandId: "cmd_1",
      accepted: true,
      status: "accepted",
    });
    await expect(client.getCommand("cmd_1")).resolves.toMatchObject({
      id: "cmd_1",
      type: "worktree.create",
      command: { payload: { launchHarness: "codex" } },
    });
    await expect(client.reconcile("manual")).resolves.toMatchObject({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason: "manual",
    });
    await expect(client.runDoctor()).resolves.toMatchObject({
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
    });
    await expect(client.collectDiagnostics()).resolves.toMatchObject({
      schemaVersion: STATION_SCHEMA_VERSION,
      commands: [],
      events: [],
    });

    const hookEvent: ProviderHookEvent = {
      schemaVersion: STATION_SCHEMA_VERSION,
      provider: "worktrunk",
      kind: "worktree",
      event: "worktree.created",
      receivedAt: protocolTestNow,
    };
    await expect(client.ingestProviderHookEvent(hookEvent)).resolves.toMatchObject({
      provider: "worktrunk",
      status: "accepted",
    });

    const report: HarnessEventReport = {
      schemaVersion: STATION_SCHEMA_VERSION,
      reportId: "report_1",
      provider: "codex",
      kind: "harness",
      eventType: "PreToolUse",
      observedAt: protocolTestNow,
      status: {
        value: "working",
        confidence: "medium",
        reason: "Codex is about to use Bash.",
        source: "harness_event",
        updatedAt: protocolTestNow,
      },
    };
    await expect(client.reportHarnessEvent(report)).resolves.toMatchObject({
      provider: "codex",
      status: "accepted",
    });

    await server.close();
  });

  it.each([
    ["another build", `0.0.0+station.${"a".repeat(64)}`],
    ["a legacy Observer", undefined],
  ] as const)("rejects pinned operations before invoking %s", async (_scenario: string, actualBuildVersion:
    | string
    | undefined) => {
    const { socketPath } = await createTempSocketPath();
    const expectedBuildVersion = `0.0.0+station.${"b".repeat(64)}`;
    const baseApi = createFakeObserverApi();
    const health = await baseApi.health();
    const reportedHealth = { ...health };
    if (actualBuildVersion === undefined) {
      delete reportedHealth.version;
    } else {
      reportedHealth.version = actualBuildVersion;
    }
    let reconcileCalls = 0;
    let recoveryInventoryCalls = 0;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        health: async () => reportedHealth,
        reconcile: async (reason) => {
          reconcileCalls += 1;
          return baseApi.reconcile(reason);
        },
        getSessionRecoveryInventory: async () => {
          recoveryInventoryCalls += 1;
          return baseApi.getSessionRecoveryInventory();
        },
      }),
    });
    const client = createObserverClient({
      socketPath,
      expectedBuildVersion,
      requestId: ids("mismatch"),
    });

    try {
      await expect(client.reconcile("must-not-run")).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "OBSERVER_BUILD_MISMATCH",
        message: expect.stringContaining(
          `expects "${expectedBuildVersion}", but the socket owner reports "${actualBuildVersion ?? "missing"}"`,
        ),
        hint: expect.stringContaining("isolated observer socket_path and state_dir"),
      });
      expect(reconcileCalls).toBe(0);
      await expect(client.getSessionRecoveryInventory()).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "OBSERVER_BUILD_MISMATCH",
      });
      expect(recoveryInventoryCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("runs a pinned mutation after checking the matching build on the same connection", async () => {
    const { socketPath } = await createTempSocketPath();
    const buildVersion = `0.0.0+station.${"c".repeat(64)}`;
    const baseApi = createFakeObserverApi();
    const health = { ...(await baseApi.health()), version: buildVersion };
    const receipt = await baseApi.reconcile("matching-build");
    const methods: string[] = [];
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(healthRequest.method);
        connection.send(protocolSuccessResponse(healthRequest.id, "observer.health", health));

        const mutationRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(mutationRequest.method);
        connection.send(protocolSuccessResponse(mutationRequest.id, "observer.reconcile", receipt));
      },
    });
    const client = createObserverClient({
      socketPath,
      expectedBuildVersion: buildVersion,
      requestId: ids("matching"),
    });

    try {
      await expect(client.reconcile("matching-build")).resolves.toMatchObject({
        reason: "matching-build",
      });
      expect(connectionCount).toBe(1);
      expect(methods).toEqual(["observer.health", "observer.reconcile"]);
    } finally {
      await server.close();
    }
  });

  it("checks exact process health and stops it on one connection", async () => {
    const { socketPath } = await createTempSocketPath();
    const expectedObserverIdentity = {
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"e".repeat(64)}`,
      socketPath,
    };
    const baseApi = createFakeObserverApi();
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const stopReceipt = await baseApi.stop();
    const methods: string[] = [];
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(healthRequest.method);
        connection.send(protocolSuccessResponse(healthRequest.id, "observer.health", health));

        const stopRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(stopRequest.method);
        connection.send(protocolSuccessResponse(stopRequest.id, "observer.stop", stopReceipt));
      },
    });
    const client = createObserverClient({
      socketPath,
      expectedObserverIdentity,
      requestId: ids("exact-stop"),
    });

    try {
      await expect(client.stop()).resolves.toMatchObject({ stopped: true });
      expect(connectionCount).toBe(1);
      expect(methods).toEqual(["observer.health", "observer.stop"]);
    } finally {
      await server.close();
    }
  });

  it("runs exact health, recovery, revalidation, stop, and peer closure on one connection", async () => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"f".repeat(64)}`,
      socketPath,
    };
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const recovery = await baseApi.getSessionRecoveryAssessment();
    const stopReceipt = await baseApi.stop();
    const stopResponded = deferred<void>();
    const closePeer = deferred<void>();
    const methods: string[] = [];
    let connectionCount = 0;
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        for (const expectedMethod of [
          "observer.health",
          "session.recoveryAssessment",
          "observer.health",
          "observer.stop",
        ] as const) {
          const request = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(request.method);
          expect(request.method).toBe(expectedMethod);
          if (request.method === "observer.health") {
            connection.send(protocolSuccessResponse(request.id, "observer.health", health));
          } else if (request.method === "session.recoveryAssessment") {
            connection.send(
              protocolSuccessResponse(request.id, "session.recoveryAssessment", recovery),
            );
          } else {
            stopRequests += 1;
            connection.send(protocolSuccessResponse(request.id, "observer.stop", stopReceipt));
            stopResponded.resolve(undefined);
          }
        }
        await closePeer.promise;
        connection.close();
      },
    });

    try {
      let settled = false;
      const lifecycle = withExactObserverLifecycleSession(
        {
          socketPath,
          expectedObserverIdentity,
          deadlineMs: Date.now() + 2_000,
        },
        async (session) => {
          await session.health();
          await session.getSessionRecoveryAssessment();
          await session.health();
          return session.stop();
        },
      );
      void lifecycle.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await stopResponded.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      closePeer.resolve(undefined);
      await expect(lifecycle).resolves.toEqual(stopReceipt);
      expect(connectionCount).toBe(1);
      expect(stopRequests).toBe(1);
      expect(methods).toEqual([
        "observer.health",
        "session.recoveryAssessment",
        "observer.health",
        "observer.stop",
      ]);
    } finally {
      closePeer.resolve(undefined);
      await server.close();
    }
  });

  it("snapshots the lifecycle deadline before caller-owned options can extend it", async () => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"7".repeat(64)}`,
      socketPath,
    };
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const stopReceipt = await baseApi.stop();
    const connectionHandled = deferred<void>();
    const methods: string[] = [];
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        const iterator = connection.messages()[Symbol.asyncIterator]();
        try {
          const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(healthRequest.method);
          connection.send(protocolSuccessResponse(healthRequest.id, "observer.health", health));
          const next = await iterator.next();
          if (!next.done) {
            const request = ProtocolRequestSchema.parse(next.value);
            methods.push(request.method);
            if (request.method === "observer.stop") {
              stopRequests += 1;
              connection.send(protocolSuccessResponse(request.id, "observer.stop", stopReceipt));
              connection.close();
            }
          }
        } finally {
          connectionHandled.resolve(undefined);
        }
      },
    });
    const originalDeadlineMs = Date.now() + 2_000;
    const options = { socketPath, expectedObserverIdentity, deadlineMs: originalDeadlineMs };
    let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      const lifecycle = withExactObserverLifecycleSession(options, async (session) => {
        await session.health();
        options.deadlineMs = originalDeadlineMs + 10_000;
        nowSpy = vi.spyOn(Date, "now").mockReturnValue(originalDeadlineMs);
        return session.stop();
      });
      await expect(lifecycle).rejects.toMatchObject({ code: "PROTOCOL_REQUEST_TIMEOUT" });
      await connectionHandled.promise;
      expect(stopRequests).toBe(0);
      expect(methods).toEqual(["observer.health"]);
    } finally {
      nowSpy?.mockRestore();
      await server.close();
    }
  });

  it.each([
    ["healthy status", "status", "PROTOCOL_REQUEST_FAILED"],
    ["startedAt", "startedAt", "OBSERVER_BUILD_MISMATCH"],
  ] as const)("snapshots lifecycle %s before caller-owned options can mutate", async (_name, field, code) => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const changedStartedAt = "2026-08-24T12:00:02.000Z";
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"8".repeat(64)}`,
      socketPath,
    };
    const mutation =
      field === "status" ? { status: "degraded" as const } : { startedAt: changedStartedAt };
    const reportedHealth = {
      ...(await baseApi.health()),
      ...expectedObserverIdentity,
      ...mutation,
    };
    const stopReceipt = await baseApi.stop();
    const connectionHandled = deferred<void>();
    const methods: string[] = [];
    let connectionCount = 0;
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        try {
          const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(healthRequest.method);
          connection.send(
            protocolSuccessResponse(healthRequest.id, "observer.health", reportedHealth),
          );
          const next = await iterator.next();
          if (!next.done) {
            const request = ProtocolRequestSchema.parse(next.value);
            methods.push(request.method);
            if (request.method === "observer.stop") {
              stopRequests += 1;
              connection.send(protocolSuccessResponse(request.id, "observer.stop", stopReceipt));
              connection.close();
            }
          }
        } finally {
          connectionHandled.resolve(undefined);
        }
      },
    });
    const options = {
      socketPath,
      expectedObserverIdentity,
      deadlineMs: Date.now() + 2_000,
    };

    try {
      const lifecycle = withExactObserverLifecycleSession(options, async (session) => {
        await session.health();
        return session.stop();
      });
      Object.assign(options.expectedObserverIdentity, mutation);
      await expect(lifecycle).rejects.toMatchObject({ code });
      await connectionHandled.promise;
      expect(connectionCount).toBe(1);
      expect(stopRequests).toBe(0);
      expect(methods).toEqual(["observer.health"]);
    } finally {
      await server.close();
    }
  });

  it.each([
    "health",
    "recovery",
  ] as const)("clears exact stop authorization before a failed later %s request", async (laterRequest) => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"9".repeat(64)}`,
      socketPath,
    };
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const stopReceipt = await baseApi.stop();
    const connectionHandled = deferred<void>();
    const methods: string[] = [];
    let connectionCount = 0;
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        try {
          const firstHealth = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(firstHealth.method);
          connection.send(protocolSuccessResponse(firstHealth.id, "observer.health", health));

          const later = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(later.method);
          if (laterRequest === "health") {
            connection.send(
              protocolSuccessResponse(later.id, "observer.health", {
                ...health,
                status: "degraded",
              }),
            );
          } else {
            connection.send({
              schemaVersion: STATION_SCHEMA_VERSION,
              jsonrpc: "2.0",
              id: later.id,
              result: {},
            });
          }

          const next = await iterator.next();
          if (!next.done) {
            const request = ProtocolRequestSchema.parse(next.value);
            methods.push(request.method);
            if (request.method === "observer.stop") {
              stopRequests += 1;
              connection.send(protocolSuccessResponse(request.id, "observer.stop", stopReceipt));
              connection.close();
            }
          }
        } finally {
          connectionHandled.resolve(undefined);
        }
      },
    });

    try {
      await expect(
        withExactObserverLifecycleSession(
          {
            socketPath,
            expectedObserverIdentity,
            deadlineMs: Date.now() + 2_000,
          },
          async (session) => {
            await session.health();
            await (laterRequest === "health"
              ? session.health()
              : session.getSessionRecoveryAssessment()
            ).catch(() => undefined);
            return session.stop();
          },
        ),
      ).rejects.toMatchObject({ code: "PROTOCOL_REQUEST_FAILED" });
      await connectionHandled.promise;
      expect(connectionCount).toBe(1);
      expect(stopRequests).toBe(0);
      expect(methods).toEqual([
        "observer.health",
        laterRequest === "health" ? "observer.health" : "session.recoveryAssessment",
      ]);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["missing socket", "socket"],
    ["changed status", "status"],
  ] as const)("requires strict exact-session identity for %s", async (_name, mismatch) => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"a".repeat(64)}`,
      socketPath,
    };
    const exactHealth = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const { socketPath: _ignored, ...healthWithoutSocket } = exactHealth;
    const reportedHealth =
      mismatch === "socket" ? healthWithoutSocket : { ...exactHealth, status: "degraded" as const };
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const request = ProtocolRequestSchema.parse((await iterator.next()).value);
        connection.send(protocolSuccessResponse(request.id, "observer.health", reportedHealth));
      },
    });

    try {
      const run = () =>
        withExactObserverLifecycleSession(
          {
            socketPath,
            expectedObserverIdentity,
            deadlineMs: Date.now() + 2_000,
          },
          (session) => session.health(),
        );
      const first = (await run().catch((error) => error)) as SafeError;
      expect(first).toMatchObject({ code: "PROTOCOL_REQUEST_FAILED" });
      first.code = "MUTATED_BY_CALLER";
      await expect(run()).rejects.toMatchObject({ code: "PROTOCOL_REQUEST_FAILED" });
      expect(connectionCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("returns fresh exact lifecycle deadline errors", async () => {
    const run = () =>
      withExactObserverLifecycleSession(
        {
          socketPath: "/tmp/station-expired.sock",
          expectedObserverIdentity: {
            status: "healthy",
            pid: 42,
            startedAt: protocolTestNow,
            version: `0.0.0+station.${"a".repeat(64)}`,
            socketPath: "/tmp/station-expired.sock",
          },
          deadlineMs: 0,
        },
        (session) => session.health(),
      );
    const first = (await run().catch((error) => error)) as SafeError;
    expect(first).toMatchObject({ code: "PROTOCOL_REQUEST_TIMEOUT" });
    first.code = "MUTATED_BY_CALLER";
    await expect(run()).rejects.toMatchObject({ code: "PROTOCOL_REQUEST_TIMEOUT" });
  });

  it("does not negotiate or reconnect an exact lifecycle session", async () => {
    const { socketPath } = await createTempSocketPath();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"b".repeat(64)}`,
      socketPath,
    };
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const request = ProtocolRequestSchema.parse((await iterator.next()).value);
        connection.send({
          schemaVersion: "0.10.0",
          jsonrpc: "2.0",
          id: request.id,
          result: { schemaVersion: "0.10.0", ...expectedObserverIdentity },
        });
      },
    });

    try {
      await expect(
        withExactObserverLifecycleSession(
          {
            socketPath,
            expectedObserverIdentity,
            deadlineMs: Date.now() + 2_000,
          },
          (session) => session.health(),
        ),
      ).rejects.toMatchObject({ code: "PROTOCOL_SCHEMA_MISMATCH" });
      expect(connectionCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["deadline", "health", 0, "PROTOCOL_REQUEST_TIMEOUT"],
    ["deadline", "recovery", 1, "PROTOCOL_REQUEST_TIMEOUT"],
    ["deadline", "revalidation", 2, "PROTOCOL_REQUEST_TIMEOUT"],
    ["deadline", "stop receipt", 3, "PROTOCOL_REQUEST_TIMEOUT"],
    ["connection loss", "health", 0, "PROTOCOL_SOCKET_CLOSED"],
    ["connection loss", "recovery", 1, "PROTOCOL_SOCKET_CLOSED"],
    ["connection loss", "revalidation", 2, "PROTOCOL_SOCKET_CLOSED"],
    ["connection loss", "stop receipt", 3, "PROTOCOL_SOCKET_CLOSED"],
  ] as const)("fails closed without reconnect on %s during pinned %s", async (failure, _stage, failureIndex, code) => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"d".repeat(64)}`,
      socketPath,
    };
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const recovery = await baseApi.getSessionRecoveryAssessment();
    const methods: string[] = [];
    let connectionCount = 0;
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        for (const [index, method] of [
          "observer.health",
          "session.recoveryAssessment",
          "observer.health",
          "observer.stop",
        ].entries()) {
          const request = ProtocolRequestSchema.parse((await iterator.next()).value);
          methods.push(request.method);
          expect(request.method).toBe(method);
          if (request.method === "observer.stop") stopRequests += 1;
          if (index === failureIndex) {
            if (failure === "connection loss") connection.close();
            return;
          }
          if (request.method === "observer.health") {
            connection.send(protocolSuccessResponse(request.id, "observer.health", health));
          } else {
            connection.send(
              protocolSuccessResponse(request.id, "session.recoveryAssessment", recovery),
            );
          }
        }
      },
    });

    try {
      await expect(
        withExactObserverLifecycleSession(
          {
            socketPath,
            expectedObserverIdentity,
            deadlineMs: Date.now() + (failure === "deadline" ? 100 : 2_000),
          },
          async (session) => {
            await session.health();
            await session.getSessionRecoveryAssessment();
            await session.health();
            return session.stop();
          },
        ),
      ).rejects.toMatchObject({ code });
      expect(connectionCount).toBe(1);
      expect(stopRequests).toBe(failureIndex === 3 ? 1 : 0);
      expect(methods).toHaveLength(failureIndex + 1);
    } finally {
      await server.close();
    }
  });

  it.each([
    "closed-before-receipt",
    "false-receipt",
    "missing-receipt",
    "extra-frame",
    "closure-timeout",
  ] as const)("fails exact stop without retry when the outcome is %s", async (outcome) => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      status: "healthy" as const,
      pid: 42,
      startedAt: protocolTestNow,
      version: `0.0.0+station.${"c".repeat(64)}`,
      socketPath,
    };
    const health = { ...(await baseApi.health()), ...expectedObserverIdentity };
    const stopReceipt = await baseApi.stop();
    let connectionCount = 0;
    let stopRequests = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        connection.send(protocolSuccessResponse(healthRequest.id, "observer.health", health));
        const stopRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        stopRequests += 1;
        if (outcome === "closed-before-receipt") {
          connection.close();
        } else if (outcome === "missing-receipt") {
          const { stopped: _stopped, ...missingReceipt } = stopReceipt;
          connection.send({
            schemaVersion: STATION_SCHEMA_VERSION,
            jsonrpc: "2.0",
            id: stopRequest.id,
            result: missingReceipt,
          });
        } else {
          connection.send(
            protocolSuccessResponse(stopRequest.id, "observer.stop", {
              ...stopReceipt,
              stopped: outcome !== "false-receipt",
            }),
          );
          if (outcome === "extra-frame") {
            connection.send(protocolSuccessResponse("extra", "observer.health", health));
            connection.close();
          }
        }
      },
    });

    try {
      await expect(
        withExactObserverLifecycleSession(
          {
            socketPath,
            expectedObserverIdentity,
            deadlineMs: Date.now() + (outcome === "closure-timeout" ? 100 : 2_000),
          },
          async (session) => {
            await session.health();
            return session.stop();
          },
        ),
      ).rejects.toMatchObject({
        code:
          outcome === "closed-before-receipt"
            ? "PROTOCOL_SOCKET_CLOSED"
            : outcome === "false-receipt"
              ? "PROTOCOL_REQUEST_FAILED"
              : outcome === "missing-receipt"
                ? "PROTOCOL_RESPONSE_VALIDATION_FAILED"
                : outcome === "extra-frame"
                  ? "PROTOCOL_REQUEST_FAILED"
                  : "PROTOCOL_REQUEST_TIMEOUT",
      });
      expect(connectionCount).toBe(1);
      expect(stopRequests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retries the previous lifecycle schema for an identity-pinned stop", async () => {
    const { socketPath } = await createTempSocketPath();
    const expectedObserverIdentity = {
      pid: 42,
      startedAt: protocolTestNow,
      version: "0.0.0-pre-alpha.5.2",
      socketPath,
    };
    const previousLifecycleRequestSchema = z
      .object({
        schemaVersion: z.literal("0.11.0"),
        jsonrpc: z.literal("2.0"),
        id: z.string().min(1),
        method: z.enum(["observer.health", "observer.stop"]),
      })
      .strict();
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const firstRequest = (await iterator.next()).value;
        if (connectionCount === 1) {
          const currentRequest = ProtocolRequestSchema.parse(firstRequest);
          connection.send({
            schemaVersion: "0.11.0",
            jsonrpc: "2.0",
            id: currentRequest.id,
            error: {
              tag: "ProtocolError",
              code: "PROTOCOL_ERROR",
              message: "Invalid protocol request.",
            },
          });
          return;
        }

        const healthRequest = previousLifecycleRequestSchema.parse(firstRequest);
        expect(healthRequest.method).toBe("observer.health");
        connection.send({
          schemaVersion: "0.11.0",
          jsonrpc: "2.0",
          id: healthRequest.id,
          result: {
            schemaVersion: "0.11.0",
            status: "healthy",
            ...expectedObserverIdentity,
          },
        });

        const stopRequest = previousLifecycleRequestSchema.parse((await iterator.next()).value);
        expect(stopRequest.method).toBe("observer.stop");
        connection.send({
          schemaVersion: "0.11.0",
          jsonrpc: "2.0",
          id: stopRequest.id,
          result: { schemaVersion: "0.11.0", stopped: true, at: protocolTestNow },
        });
      },
    });
    const client = createObserverClient({
      socketPath,
      expectedObserverIdentity,
      acceptPreviousLifecycleSchema: true,
      requestId: ids("previous-stop"),
    });

    try {
      await expect(client.stop()).resolves.toEqual({
        schemaVersion: STATION_SCHEMA_VERSION,
        stopped: true,
        at: protocolTestNow,
      });
      expect(connectionCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("normalizes previous health provider IDs and readiness responses", async () => {
    const { socketPath } = await createTempSocketPath();
    const previousRequestSchema = z
      .object({
        schemaVersion: z.literal("0.11.0"),
        jsonrpc: z.literal("2.0"),
        id: z.string().min(1),
        method: z.enum(["observer.health", "session.recoveryReadiness", "observer.stop"]),
      })
      .strict();
    const legacyHealth = {
      schemaVersion: "0.11.0",
      status: "healthy",
      pid: 42,
      startedAt: protocolTestNow,
      version: "0.0.0",
      providerHealth: {
        tmux: {
          providerId: "tmux",
          providerType: "terminal",
          status: "healthy",
          lastCheckedAt: protocolTestNow,
        },
      },
    } as const;
    const readiness = {
      resumeEnabled: true,
      canonicalTitleImport: true,
      managedTerminal: { provider: "native", canLaunchProcessPersistently: true },
      harnesses: [],
    } as const;
    const legacyStop = {
      schemaVersion: "0.11.0",
      stopped: true,
      at: protocolTestNow,
    } as const;
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const request = (await iterator.next()).value;
        if (connectionCount % 2 === 1) {
          const currentRequest = ProtocolRequestSchema.parse(request);
          connection.send({
            schemaVersion: "0.11.0",
            jsonrpc: "2.0",
            id: currentRequest.id,
            error: {
              tag: "ProtocolError",
              code: "PROTOCOL_ERROR",
              message: "Invalid protocol request.",
            },
          });
          return;
        }

        const previousRequest = previousRequestSchema.parse(request);
        connection.send({
          schemaVersion: "0.11.0",
          jsonrpc: "2.0",
          id: previousRequest.id,
          result:
            previousRequest.method === "observer.health"
              ? legacyHealth
              : previousRequest.method === "observer.stop"
                ? legacyStop
                : readiness,
        });
      },
    });
    const client = createObserverClient({
      socketPath,
      acceptPreviousLifecycleSchema: true,
    });

    try {
      await expect(client.health()).resolves.toEqual({
        ...legacyHealth,
        schemaVersion: STATION_SCHEMA_VERSION,
        providerHealth: {
          tmux: {
            provider: "tmux",
            providerType: "terminal",
            status: "healthy",
            lastCheckedAt: protocolTestNow,
          },
        },
      });
      await expect(client.getSessionRecoveryReadiness()).resolves.toEqual(readiness);
      await expect(client.stop()).resolves.toEqual({
        ...legacyStop,
        schemaVersion: STATION_SCHEMA_VERSION,
      });
      expect(connectionCount).toBe(6);
    } finally {
      await server.close();
    }
  });

  it("checks legacy process health and stops it on one connection", async () => {
    const { socketPath } = await createTempSocketPath();
    const expectedObserverIdentity = {
      pid: 42,
      startedAt: protocolTestNow,
      socketPath,
    };
    const baseApi = createFakeObserverApi();
    const legacyHealth = {
      ...(await baseApi.health()),
      pid: expectedObserverIdentity.pid,
      startedAt: expectedObserverIdentity.startedAt,
    };
    delete legacyHealth.version;
    delete legacyHealth.socketPath;
    const stopReceipt = await baseApi.stop();
    const methods: string[] = [];
    let connectionCount = 0;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        connectionCount += 1;
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const healthRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(healthRequest.method);
        connection.send(protocolSuccessResponse(healthRequest.id, "observer.health", legacyHealth));

        const stopRequest = ProtocolRequestSchema.parse((await iterator.next()).value);
        methods.push(stopRequest.method);
        connection.send(protocolSuccessResponse(stopRequest.id, "observer.stop", stopReceipt));
      },
    });
    const client = createObserverClient({
      socketPath,
      expectedObserverIdentity,
      requestId: ids("legacy-stop"),
    });

    try {
      await expect(client.stop()).resolves.toMatchObject({ stopped: true });
      expect(connectionCount).toBe(1);
      expect(methods).toEqual(["observer.health", "observer.stop"]);
    } finally {
      await server.close();
    }
  });

  it("refuses to stop when the socket process changed after attribution", async () => {
    const { socketPath } = await createTempSocketPath();
    const buildVersion = `0.0.0+station.${"d".repeat(64)}`;
    const baseApi = createFakeObserverApi();
    const expectedObserverIdentity = {
      pid: 41,
      startedAt: protocolTestNow,
      version: buildVersion,
      socketPath,
    };
    let stopCalls = 0;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        health: async () => ({
          ...(await baseApi.health()),
          ...expectedObserverIdentity,
          pid: expectedObserverIdentity.pid + 1,
        }),
        stop: async () => {
          stopCalls += 1;
          return baseApi.stop();
        },
      }),
    });
    const client = createObserverClient({
      socketPath,
      expectedObserverIdentity,
      requestId: ids("exact-process"),
    });

    try {
      await expect(client.stop()).rejects.toMatchObject({
        code: "OBSERVER_BUILD_MISMATCH",
        message: "Observer process changed before the guarded operation could run.",
      });
      expect(stopCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("runs the lifecycle guard again for a mutation queued after stop", async () => {
    const { socketPath } = await createTempSocketPath();
    const baseApi = createFakeObserverApi();
    let stopping = false;
    let reconcileCalls = 0;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        stop: async () => {
          stopping = true;
          return baseApi.stop();
        },
        reconcile: async (reason) => {
          reconcileCalls += 1;
          return baseApi.reconcile(reason);
        },
      }),
      requestGuard: (method) => {
        if (stopping && method !== "observer.health" && method !== "observer.stop") {
          throw {
            tag: "ObserverLifecycleError",
            code: "OBSERVER_STOPPING",
            message: "Observer is stopping and cannot accept new operations.",
          };
        }
      },
    });
    const client = createObserverClient({ socketPath, requestId: ids("stopping") });

    try {
      await expect(client.health()).resolves.toMatchObject({ status: "healthy" });
      await expect(client.stop()).resolves.toMatchObject({ stopped: true });
      await expect(client.reconcile("must-not-run")).rejects.toMatchObject({
        code: "OBSERVER_STOPPING",
      });
      expect(reconcileCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("round-trips agent.prepareExternalLaunch and agent.reportExternalExit", async () => {
    const { socketPath } = await createTempSocketPath();
    const preparedParams: unknown[] = [];
    const exitParams: unknown[] = [];
    const api = createFakeObserverApi({
      prepareExternalLaunch: async (params) => {
        preparedParams.push(params);
        return {
          kind: "prepared",
          sessionId: "ses_round_trip",
          terminalTargetId: `native:${params.worktreeId}`,
          launchPlan: {
            provider: "claude",
            command: "claude",
            args: ["--settings", "/tmp/station/settings.json"],
            cwd: "/tmp/station/web/feature",
            env: { STATION_SESSION_ID: "ses_round_trip" },
            mode: "interactive",
          },
          attachment: {
            kind: "managed-terminal",
            terminalTargetId: `native:${params.worktreeId}`,
          },
        };
      },
      reportExternalExit: async (params) => {
        exitParams.push(params);
        return {
          acknowledged: true,
          terminalTargetId: params.terminalTargetId,
        };
      },
    });
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("agent") });

    try {
      await expect(
        client.prepareExternalLaunch({
          projectId: "web",
          worktreeId: "wt_web_feature",
          title: "Hexagonal PT 12",
          group: { kind: "existing", groupId: "grp_active" },
          freshStart: { expectedSessionId: "ses_interrupted" },
        }),
      ).resolves.toEqual({
        kind: "prepared",
        sessionId: "ses_round_trip",
        terminalTargetId: "native:wt_web_feature",
        launchPlan: {
          provider: "claude",
          command: "claude",
          args: ["--settings", "/tmp/station/settings.json"],
          cwd: "/tmp/station/web/feature",
          env: { STATION_SESSION_ID: "ses_round_trip" },
          mode: "interactive",
        },
        attachment: {
          kind: "managed-terminal",
          terminalTargetId: "native:wt_web_feature",
        },
      });
      expect(preparedParams).toEqual([
        {
          projectId: "web",
          worktreeId: "wt_web_feature",
          title: "Hexagonal PT 12",
          group: { kind: "existing", groupId: "grp_active" },
          freshStart: { expectedSessionId: "ses_interrupted" },
        },
      ]);
      await client.prepareExternalLaunch({
        projectId: "web",
        worktreeId: "wt_web_inline",
        group: { kind: "create", name: "Inline work" },
      });
      expect(preparedParams[1]).toEqual({
        projectId: "web",
        worktreeId: "wt_web_inline",
        group: { kind: "create", name: "Inline work" },
      });
      await client.prepareExternalLaunch({
        projectId: "web",
        worktreeId: "wt_web_fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_web_source",
          groupId: "grp_active",
        },
      });
      expect(preparedParams[2]).toEqual({
        projectId: "web",
        worktreeId: "wt_web_fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_web_source",
          groupId: "grp_active",
        },
      });
      const rejected = await sendRawRequest(socketPath, {
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "bad_group_placement",
        method: "agent.prepareExternalLaunch",
        params: {
          projectId: "web",
          worktreeId: "wt_web_feature",
          group: { kind: "existing", groupId: "grp_active", name: "mixed" },
        },
      });
      expect(rejected).toMatchObject({ error: { code: "PROTOCOL_VALIDATION_FAILED" } });
      await expect(
        client.reportExternalExit({
          terminalTargetId: "native:wt_web_feature",
          expectedSessionId: "ses_round_trip",
        }),
      ).resolves.toEqual({ acknowledged: true, terminalTargetId: "native:wt_web_feature" });
      expect(exitParams).toEqual([
        {
          terminalTargetId: "native:wt_web_feature",
          expectedSessionId: "ses_round_trip",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("round-trips worktree removal reservation lifecycle", async () => {
    const { socketPath } = await createTempSocketPath();
    const prepared: unknown[] = [];
    const cancelled: unknown[] = [];
    const api = createFakeObserverApi({
      prepareWorktreeRemoval: async (params) => {
        prepared.push(params);
        return {
          reservationId: "reservation_round_trip",
          projectId: params.projectId ?? "web",
          worktreeId: params.worktreeId,
          externalTerminalExitRequired: false,
        };
      },
      cancelWorktreeRemoval: async (params) => {
        cancelled.push(params);
        return { cancelled: true };
      },
    });
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("removal") });

    try {
      await expect(
        client.prepareWorktreeRemoval({
          projectId: "web",
          worktreeId: "wt_web_feature",
          expectedPath: "/tmp/station/web/feature",
          expectedBranch: "feature",
          expectedRegistrationIdentity: "registration_1",
          force: true,
        }),
      ).resolves.toEqual({
        reservationId: "reservation_round_trip",
        projectId: "web",
        worktreeId: "wt_web_feature",
        externalTerminalExitRequired: false,
      });
      await expect(
        client.cancelWorktreeRemoval({ reservationId: "reservation_round_trip" }),
      ).resolves.toEqual({ cancelled: true });
      expect(prepared).toHaveLength(1);
      expect(cancelled).toEqual([{ reservationId: "reservation_round_trip" }]);
    } finally {
      await server.close();
    }
  });

  it("returns SafeError envelopes for invalid params without leaking validator details", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({ socketPath, api: createFakeObserverApi() });

    try {
      const response = await sendRawRequest(socketPath, {
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "bad_params",
        method: "snapshot.get",
        params: { includeDebug: "yes" },
      });

      expect(response).toMatchObject({
        id: "bad_params",
        error: {
          tag: "ProtocolError",
          code: "PROTOCOL_VALIDATION_FAILED",
          message: "Observer protocol payload failed validation.",
          hint: "If station was just rebuilt, restart the observer so it loads the current schema.",
        },
      });
      expect(JSON.stringify(response)).not.toContain("ZodError");
      expect(JSON.stringify(response)).not.toContain("includeDebug");
    } finally {
      await server.close();
    }
  });

  it("maps thrown method failures to SafeError without raw stack leakage", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        health: async () => {
          throw {
            tag: "InternalObserverError",
            code: "INTERNAL_OBSERVER_FAILURE",
            message: "database exploded\n    at secret-internal-frame",
            stack: "secret stack",
          };
        },
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("err") });

    try {
      await expect(client.health()).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "PROTOCOL_ERROR",
        message: "Observer protocol method failed.",
      });
      await client.health().catch((error) => {
        expect(JSON.stringify(error)).not.toContain("secret");
        expect(JSON.stringify(error)).not.toContain("stack");
      });
    } finally {
      await server.close();
    }
  });

  it("returns undefined for a missing command record", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({ socketPath, api: createFakeObserverApi() });
    const client = createObserverClient({ socketPath, requestId: ids("missing") });

    try {
      await expect(client.getCommand("cmd_missing")).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("times out when a connected socket never returns a response", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: () => undefined,
    });
    const client = createObserverClient({ socketPath, timeoutMs: 10, requestId: ids("timeout") });

    try {
      await expect(client.health()).rejects.toMatchObject({
        tag: "TimeoutError",
        code: "PROTOCOL_REQUEST_TIMEOUT",
      });
    } finally {
      await server.close();
    }
  });

  it("reports protocol schema mismatches before generic response validation", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const request = await iterator.next();
        const requestId =
          typeof request.value === "object" &&
          request.value !== null &&
          "id" in request.value &&
          typeof request.value.id === "string"
            ? request.value.id
            : "unknown";
        connection.send({
          schemaVersion: "9.9.9",
          jsonrpc: "2.0",
          id: requestId,
          result: {
            status: "healthy",
          },
        });
      },
    });
    const client = createObserverClient({ socketPath, timeoutMs: 1000, requestId: ids("schema") });

    try {
      await expect(client.health()).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "PROTOCOL_SCHEMA_MISMATCH",
        message:
          "Observer protocol schema mismatch: the observer responded with schema 9.9.9, but this CLI expects schema 0.12.0.",
        hint: expect.stringContaining("A different STATION checkout"),
      });
    } finally {
      await server.close();
    }
  });

  it("reports response result validation failures with method context", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        const iterator = connection.messages()[Symbol.asyncIterator]();
        const request = await iterator.next();
        const requestId =
          typeof request.value === "object" &&
          request.value !== null &&
          "id" in request.value &&
          typeof request.value.id === "string"
            ? request.value.id
            : "unknown";
        connection.send({
          schemaVersion: STATION_SCHEMA_VERSION,
          jsonrpc: "2.0",
          id: requestId,
          result: {
            status: "healthy",
          },
        });
      },
    });
    const client = createObserverClient({
      socketPath,
      timeoutMs: 1000,
      requestId: ids("invalid_result"),
    });

    try {
      await expect(client.getSnapshot()).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "PROTOCOL_RESPONSE_VALIDATION_FAILED",
        message: "Observer protocol response failed validation for snapshot.get.",
        hint: expect.stringContaining("different STATION build"),
      });
    } finally {
      await server.close();
    }
  });

  it("maps server handler timeout to a typed protocol error", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({
      socketPath,
      requestTimeoutMs: 10,
      api: createFakeObserverApi({
        health: async () => new Promise(() => undefined),
      }),
    });
    const client = createObserverClient({ socketPath, timeoutMs: 200, requestId: ids("handler") });

    try {
      await expect(client.health()).rejects.toMatchObject({
        tag: "TimeoutError",
        code: "PROTOCOL_HANDLER_TIMEOUT",
      });
    } finally {
      await server.close();
    }
  });

  it("lets diagnostic handlers use the diagnostic timeout budget", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({
      socketPath,
      requestTimeoutMs: 10,
      api: createFakeObserverApi({
        runDoctor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return createFakeObserverApi().runDoctor();
        },
      }),
    });
    const client = createObserverClient({
      socketPath,
      timeoutMs: 500,
      requestId: ids("diagnostic-timeout"),
    });

    try {
      await expect(client.runDoctor()).resolves.toMatchObject({
        schemaVersion: STATION_SCHEMA_VERSION,
        status: "healthy",
      });
    } finally {
      await server.close();
    }
  });

  it("returns SafeError envelopes for malformed API results and keeps the connection usable", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        health: async () => ({ status: "not-a-health-report" }) as never,
      }),
    });
    const connection = await connectUnixSocket(socketPath, { timeoutMs: 500 });
    const messages = connection.messages()[Symbol.asyncIterator]();

    try {
      connection.send({
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "bad_result",
        method: "observer.health",
      });
      await expect(messages.next()).resolves.toMatchObject({
        done: false,
        value: {
          id: "bad_result",
          error: {
            tag: "ProtocolError",
            code: "PROTOCOL_ERROR",
            message: "Observer protocol response validation failed.",
          },
        },
      });

      connection.send({
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "after_bad_result",
        method: "snapshot.get",
      });
      await expect(messages.next()).resolves.toMatchObject({
        done: false,
        value: {
          id: "after_bad_result",
          result: {
            schemaVersion: STATION_SCHEMA_VERSION,
            counts: { projects: 0 },
          },
        },
      });
    } finally {
      connection.close();
      await server.close();
    }
  });
});

async function sendRawRequest(socketPath: string, request: unknown): Promise<unknown> {
  const connection = await connectUnixSocket(socketPath, { timeoutMs: 500 });
  try {
    connection.send(request);
    const iterator = connection.messages()[Symbol.asyncIterator]();
    const response = await iterator.next();
    return response.value;
  } finally {
    connection.close();
  }
}
