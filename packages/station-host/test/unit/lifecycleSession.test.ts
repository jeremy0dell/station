import {
  HOST_PROTOCOL_VERSION,
  HostRequestSchema,
  hostFailure,
  hostSuccess,
  openStationHostLifecycleSession,
  stationHostSafeError,
} from "@station/host";
import { inMemoryNdjsonConnectionPair, type NdjsonConnection } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";

const manifest = {
  "pty-1": {
    bridgeProtocolVersion: 2 as const,
    bridgePid: 9,
    controlSocket: "/tmp/pty-1.sock",
    command: "/bin/sh",
    cols: 80,
    rows: 24,
    ptyInstanceId: "instance-1",
    identity: {
      kind: "agent" as const,
      terminalTargetId: "target-1",
      worktreeId: "worktree-1",
      projectId: "project-1",
      sessionId: "session-1",
      worktreePath: "/repo/one",
      harnessProvider: "codex",
    },
  },
};

type Request = ReturnType<typeof HostRequestSchema.parse>;

function startRouter(
  connection: NdjsonConnection,
  respond: (request: Request, connection: NdjsonConnection) => void,
): Promise<void> {
  return (async () => {
    for await (const value of connection.messages()) {
      respond(HostRequestSchema.parse(value), connection);
    }
  })();
}

describe("Station Host lifecycle session", () => {
  it("keeps every lifecycle exchange on one physical connection and one identity", async () => {
    const pair = inMemoryNdjsonConnectionPair();
    const requests: Request[] = [];
    let connects = 0;
    const router = startRouter(pair.server, (request, connection) => {
      requests.push(request);
      const results: Record<string, unknown> = {
        "host.health": {
          ok: true,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: "1.0.0",
        },
        "host.recoveryInventory": { buildIdentity: "a".repeat(64), ptys: [] },
        "host.stopIfIdle": { stopping: true },
        "host.beginHandoff": {
          manifest,
          fidelity: "processes",
          released: ["pty-1"],
          skipped: [],
        },
        "host.completeHandoff": { stopping: true },
        "host.adoptRegistry": { adopted: ["pty-1"], failed: [] },
      };
      connection.send(hostSuccess(request.id, results[request.method]));
    });
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 2_000,
      connect: async () => {
        connects += 1;
        return pair.client;
      },
    });

    await expect(session.health()).resolves.toMatchObject({ buildVersion: "1.0.0" });
    await expect(session.recoveryInventory()).resolves.toMatchObject({ ptys: [] });
    await expect(session.stopIfIdle("2.0.0")).resolves.toEqual({ stopping: true });
    await expect(session.beginHandoff("2.0.0", "processes")).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(session.completeHandoff()).resolves.toEqual({ stopping: true });
    await expect(session.adoptRegistry(manifest)).resolves.toEqual({
      adopted: ["pty-1"],
      failed: [],
    });

    expect(connects).toBe(1);
    expect(requests.map(({ id }) => id)).toEqual(["l0", "l1", "l2", "l3", "l4", "l5"]);
    const identityRequests = requests.filter(({ client }) => client !== undefined);
    expect(identityRequests.map(({ method }) => method)).toEqual([
      "host.recoveryInventory",
      "host.adoptRegistry",
    ]);
    expect(new Set(identityRequests.map(({ client }) => client?.connectionId)).size).toBe(1);
    session.dispose();
    await router;
  });

  it("distinguishes an explicit begin refusal and keeps the session usable", async () => {
    const pair = inMemoryNdjsonConnectionPair();
    const router = startRouter(pair.server, (request, connection) => {
      connection.send(
        request.method === "host.beginHandoff"
          ? hostFailure(
              request.id,
              stationHostSafeError("HOST_UPGRADE_BLOCKED", "The incumbent is busy."),
            )
          : hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "1.0.0",
            }),
      );
    });
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 2_000,
      connect: async () => pair.client,
    });

    await expect(session.beginHandoff("2.0.0", "processes")).resolves.toMatchObject({
      status: "refused",
      error: { code: "HOST_UPGRADE_BLOCKED" },
    });
    await expect(session.health()).resolves.toMatchObject({ buildVersion: "1.0.0" });
    session.dispose();
    await router;
  });

  it("quarantines malformed begin evidence until same-connection abort is validated", async () => {
    const pair = inMemoryNdjsonConnectionPair();
    const methods: string[] = [];
    const router = startRouter(pair.server, (request, connection) => {
      methods.push(request.method);
      const result =
        request.method === "host.abortHandoff"
          ? { adopted: ["pty-1"], failed: [] }
          : request.method === "host.health"
            ? {
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "1.0.0",
              }
            : { malformed: true };
      connection.send(hostSuccess(request.id, result));
    });
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 2_000,
      connect: async () => pair.client,
    });

    await expect(session.beginHandoff("2.0.0", "processes")).resolves.toMatchObject({
      status: "malformed-success",
    });
    await expect(session.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    await expect(session.abortHandoff()).resolves.toEqual({ adopted: ["pty-1"], failed: [] });
    await expect(session.health()).resolves.toMatchObject({ buildVersion: "1.0.0" });
    expect(methods).toEqual(["host.beginHandoff", "host.abortHandoff", "host.health"]);
    session.dispose();
    await router;
  });

  it("poisons itself on response correlation failure", async () => {
    const pair = inMemoryNdjsonConnectionPair();
    let requests = 0;
    const router = startRouter(pair.server, (request, connection) => {
      requests += 1;
      connection.send(hostSuccess(`${request.id}-wrong`, { stopping: true }));
    });
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 2_000,
      connect: async () => pair.client,
    });

    await expect(session.stopIfIdle("2.0.0")).rejects.toMatchObject({
      code: "HOST_REQUEST_FAILED",
    });
    await expect(session.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    expect(requests).toBe(1);
    await router;
  });

  it("poisons the physical session when request delivery is uncertain", async () => {
    let sends = 0;
    let closes = 0;
    const connection: NdjsonConnection = {
      send() {
        sends += 1;
        throw new Error("write failed");
      },
      async *messages() {},
      close() {
        closes += 1;
      },
      closed: Promise.resolve(),
    };
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 2_000,
      connect: async () => connection,
    });

    await expect(session.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    await expect(session.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    expect({ sends, closes }).toEqual({ sends: 1, closes: 1 });
  });

  it("closes a pending physical connection at the absolute deadline", async () => {
    const pair = inMemoryNdjsonConnectionPair();
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: Date.now() + 30,
      connect: async () => pair.client,
    });

    await expect(session.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    await expect(pair.server.closed).resolves.toBeUndefined();
  });

  it("never sends a lifecycle mutation after its absolute deadline", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let sends = 0;
    let closes = 0;
    const connection: NdjsonConnection = {
      send() {
        sends += 1;
      },
      async *messages() {},
      close() {
        closes += 1;
      },
      closed: Promise.resolve(),
    };
    const session = await openStationHostLifecycleSession({
      socketPath: "/tmp/station-host.sock",
      expectedBuildVersion: "2.0.0",
      deadlineMs: 1_001,
      connect: async () => connection,
    });

    now = 1_001;
    await expect(session.stopIfIdle("2.0.0")).rejects.toMatchObject({
      code: "HOST_REQUEST_FAILED",
    });
    expect({ sends, closes }).toEqual({ sends: 0, closes: 1 });
    vi.mocked(Date.now).mockRestore();
  });
});
