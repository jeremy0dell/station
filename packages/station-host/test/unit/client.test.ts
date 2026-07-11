import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  HostRequestSchema,
  hostFailure,
  hostSuccess,
  stationHostSafeError,
} from "@station/host";
import { inMemoryNdjsonConnectionPair, type NdjsonConnection } from "@station/protocol";
import { describe, expect, it } from "vitest";

/** Minimal in-memory host router: answers a fixed set of methods. */
function startFakeRouter(
  server: NdjsonConnection,
  options: { buildVersion?: string; onRequest?: (method: string) => void } = {},
): void {
  void runFakeRouter(server, options);
}

async function runFakeRouter(
  server: NdjsonConnection,
  options: { buildVersion?: string; onRequest?: (method: string) => void },
): Promise<void> {
  for await (const message of server.messages()) {
    const request = HostRequestSchema.parse(message);
    options.onRequest?.(request.method);
    switch (request.method) {
      case "host.health":
        server.send(
          hostSuccess(request.id, {
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: options.buildVersion ?? "test-build",
          }),
        );
        break;
      case "host.stopIfIdle":
        server.send(hostSuccess(request.id, { stopping: true }));
        break;
      case "host.spawn":
        server.send(hostSuccess(request.id, { ptyId: "pty-1", pid: 4242 }));
        break;
      case "host.list":
        server.send(hostSuccess(request.id, { ptys: [] }));
        break;
      case "host.explode":
        server.send(
          hostFailure(
            request.id,
            stationHostSafeError("HOST_SPAWN_FAILED", "boom", { worktreeId: "wt-1" }),
          ),
        );
        break;
      default:
        server.send(
          hostFailure(
            request.id,
            stationHostSafeError("HOST_BAD_REQUEST", `unknown method ${request.method}`),
          ),
        );
    }
  }
}

function clientAgainstFakeRouter() {
  const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
  startFakeRouter(server);
  return createStationHostClient({
    socketPath: "unused",
    expectedBuildVersion: "test-build",
    connect: async () => clientConn,
  });
}

describe("createStationHostClient", () => {
  it("round-trips unary requests over one multiplexed connection", async () => {
    const client = clientAgainstFakeRouter();
    await expect(client.health()).resolves.toEqual({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "test-build",
    });
    await expect(
      client.spawn({
        terminalTargetId: "native:wt-1",
        worktreeId: "wt-1",
        projectId: "proj-1",
        sessionId: "ses-1",
        worktreePath: "/repo/wt-1",
        harnessProvider: "claude",
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      }),
    ).resolves.toEqual({ ptyId: "pty-1", pid: 4242 });
    await expect(client.list()).resolves.toEqual([]);
    client.dispose();
  });

  it("throws the host's classified SafeError on a failed request", async () => {
    const client = clientAgainstFakeRouter();
    await expect(client.focus("pty-x")).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "HOST_BAD_REQUEST",
      provider: "native",
    });
    client.dispose();
  });

  it("gates operational calls while leaving lifecycle inspection available", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    let spawnRequests = 0;
    startFakeRouter(server, {
      buildVersion: "old-build",
      onRequest: (method) => {
        if (method === "host.spawn") {
          spawnRequests += 1;
        }
      },
    });
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "new-build",
      connect: async () => clientConn,
    });

    await expect(client.health()).resolves.toMatchObject({ buildVersion: "old-build" });
    await expect(client.stopIfIdle("new-build")).resolves.toEqual({ stopping: true });
    await expect(
      client.spawn({
        terminalTargetId: "native:wt-1",
        worktreeId: "wt-1",
        projectId: "proj-1",
        sessionId: "ses-1",
        worktreePath: "/repo/wt-1",
        harnessProvider: "claude",
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "HOST_VERSION_INCOMPATIBLE" });
    expect(spawnRequests).toBe(0);
    client.dispose();
  });

  it("retries compatibility after the host appears", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    startFakeRouter(server);
    let attempts = 0;
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("host not started");
        }
        return clientConn;
      },
    });

    await expect(client.list()).rejects.toMatchObject({ code: "HOST_UNREACHABLE" });
    await expect(client.list()).resolves.toEqual([]);
    expect(attempts).toBe(2);
    client.dispose();
  });

  it("rejects in-flight requests when the connection closes", async () => {
    const { client: clientConn } = inMemoryNdjsonConnectionPair();
    // No router on the server side: the request never gets a reply, then we close.
    const client = createStationHostClient({
      socketPath: "unused",
      timeoutMs: 50,
      connect: async () => clientConn,
    });
    await expect(client.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    client.dispose();
  });
});
