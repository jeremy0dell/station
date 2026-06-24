import type {
  CommandRecord,
  HarnessEventReport,
  ProviderHookEvent,
  StationCommand,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  connectUnixSocket,
  createObserverClient,
  listenUnixSocket,
  startProtocolServer,
} from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import { createFakeObserverApi, emptySnapshot, ids, protocolTestNow } from "../support/fixtures.js";

describe("protocol client/server", () => {
  it("routes health, snapshot, dispatch, get, reconcile, and hook ingestion over a socket", async () => {
    const { socketPath } = await createTempSocketPath();
    const commands = new Map<string, CommandRecord>();
    const snapshot = emptySnapshot();
    const api = createFakeObserverApi({
      snapshot,
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
    });
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("req") });

    await expect(client.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      schemaVersion: STATION_SCHEMA_VERSION,
      counts: { projects: 0 },
    });

    const command: StationCommand = {
      type: "observer.reconcile",
      payload: { reason: "protocol-test" },
    };
    await expect(client.dispatch(command)).resolves.toEqual({
      commandId: "cmd_1",
      accepted: true,
      status: "accepted",
    });
    await expect(client.getCommand("cmd_1")).resolves.toMatchObject({
      id: "cmd_1",
      type: "observer.reconcile",
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
      status: "ingested",
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

  it("round-trips agent.prepareExternalLaunch and agent.reportExternalExit", async () => {
    const { socketPath } = await createTempSocketPath();
    const api = createFakeObserverApi({
      prepareExternalLaunch: async (params) => ({
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
      }),
      reportExternalExit: async (params) => ({
        acknowledged: true,
        terminalTargetId: params.terminalTargetId,
      }),
    });
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("agent") });

    try {
      await expect(
        client.prepareExternalLaunch({ projectId: "web", worktreeId: "wt_web_feature" }),
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
      });
      await expect(
        client.reportExternalExit({ terminalTargetId: "native:wt_web_feature" }),
      ).resolves.toEqual({ acknowledged: true, terminalTargetId: "native:wt_web_feature" });
    } finally {
      await server.close();
    }
  });

  it("keeps observer.ingestHookEvent as a compatibility alias", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await startProtocolServer({ socketPath, api: createFakeObserverApi() });

    try {
      const response = await sendRawRequest(socketPath, {
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "legacy_hook_ingest",
        method: "observer.ingestHookEvent",
        params: {
          event: {
            schemaVersion: STATION_SCHEMA_VERSION,
            provider: "worktrunk",
            kind: "worktree",
            event: "worktree.created",
            receivedAt: protocolTestNow,
          },
        },
      });

      expect(response).toMatchObject({
        id: "legacy_hook_ingest",
        result: {
          provider: "worktrunk",
          status: "ingested",
        },
      });
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
          "Observer protocol schema mismatch: the observer responded with schema 9.9.9, but this CLI expects schema 0.5.0.",
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
