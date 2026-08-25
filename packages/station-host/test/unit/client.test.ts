import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  HostAttachAckSchema,
  HostClientShutdownNotificationSchema,
  HostFrameSchema,
  type HostListEntry,
  type HostRecoveryInventoryEntry,
  HostRequestSchema,
  HostResizeParamsSchema,
  HostWriteParamsSchema,
  hostFailure,
  hostSuccess,
  stationHostSafeError,
} from "@station/host";
import { inMemoryNdjsonConnectionPair, type NdjsonConnection } from "@station/protocol";
import { describe, expect, it } from "vitest";

const PTY_REF = {
  terminalTargetId: "native:wt-1",
  ptyId: "pty-1",
  ptyInstanceId: "ptyi-1",
};
const PTY_IDENTITY = {
  kind: "agent" as const,
  terminalTargetId: PTY_REF.terminalTargetId,
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
};
const PTY_EXPECTATION = { ...PTY_IDENTITY, ...PTY_REF };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms, "timeout"));

function attachAck(overrides: Record<string, unknown> = {}) {
  return {
    subscribed: true,
    attachmentId: "att-host-1",
    controlEpoch: 1,
    role: "controller",
    ...PTY_IDENTITY,
    ...PTY_REF,
    pid: 42,
    cols: 80,
    rows: 24,
    exited: false,
    replay: {
      kind: "raw-complete",
      initialCols: 80,
      initialRows: 24,
      events: [],
    },
    ...overrides,
  };
}

/** Minimal in-memory host router: answers a fixed set of methods. */
function startFakeRouter(
  server: NdjsonConnection,
  options: {
    buildVersion?: string;
    onRequest?: (method: string) => void;
    onClient?: (client: NonNullable<ReturnType<typeof HostRequestSchema.parse>["client"]>) => void;
    onShutdown?: () => void;
    listPtys?: HostListEntry[];
    recoveryPtys?: HostRecoveryInventoryEntry[];
    buildIdentity?: string;
  } = {},
): void {
  void runFakeRouter(server, options);
}

async function runFakeRouter(
  server: NdjsonConnection,
  options: {
    buildVersion?: string;
    onRequest?: (method: string) => void;
    onClient?: (client: NonNullable<ReturnType<typeof HostRequestSchema.parse>["client"]>) => void;
    onShutdown?: () => void;
    listPtys?: HostListEntry[];
    recoveryPtys?: HostRecoveryInventoryEntry[];
    buildIdentity?: string;
  },
): Promise<void> {
  for await (const message of server.messages()) {
    const shutdown = HostClientShutdownNotificationSchema.safeParse(message);
    if (shutdown.success) {
      options.onShutdown?.();
      continue;
    }
    const request = HostRequestSchema.parse(message);
    options.onRequest?.(request.method);
    if (request.client !== undefined) {
      options.onClient?.(request.client);
    }
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
      case "host.beginHandoff":
        server.send(
          hostSuccess(request.id, {
            manifest: {
              "pty-1": {
                bridgeProtocolVersion: 2,
                bridgePid: 9,
                controlSocket: "/tmp/pty-1.sock",
                command: "/bin/sh",
                cols: 80,
                rows: 24,
                ptyInstanceId: PTY_REF.ptyInstanceId,
                identity: {
                  kind: "agent",
                  terminalTargetId: "native:wt-1",
                  worktreeId: "wt-1",
                  projectId: "proj-1",
                  sessionId: "ses-1",
                  worktreePath: "/repo/wt-1",
                  harnessProvider: "claude",
                },
              },
            },
            fidelity: "processes",
            released: ["pty-1"],
            skipped: [],
          }),
        );
        break;
      case "host.completeHandoff":
        server.send(hostSuccess(request.id, { stopping: true }));
        break;
      case "host.abortHandoff":
        server.send(hostSuccess(request.id, { adopted: ["pty-1"], failed: [] }));
        break;
      case "host.adoptRegistry":
        server.send(hostSuccess(request.id, { adopted: ["pty-1"], failed: [] }));
        break;
      case "host.spawn":
        server.send(hostSuccess(request.id, { ...PTY_REF, pid: 4242 }));
        break;
      case "host.list":
        server.send(hostSuccess(request.id, { ptys: options.listPtys ?? [] }));
        break;
      case "host.recoveryInventory":
        server.send(
          hostSuccess(request.id, {
            buildIdentity: options.buildIdentity ?? "test-build-identity",
            ptys: options.recoveryPtys ?? [],
          }),
        );
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
  it("accepts only strict ordered resize frames", () => {
    const frame = { type: "resize", ptyId: "pty-1", cols: 5, rows: 4 };

    expect(HostFrameSchema.safeParse(frame)).toMatchObject({ success: true, data: frame });
    expect(HostFrameSchema.safeParse({ ...frame, unexpected: true }).success).toBe(false);
    expect(HostFrameSchema.safeParse({ ...frame, cols: 5.5 }).success).toBe(false);
    expect(HostFrameSchema.safeParse({ ...frame, rows: 0 }).success).toBe(false);
  });

  it("accepts only safe attachment epochs and capability-bound mutation shapes", () => {
    expect(
      HostWriteParamsSchema.safeParse({
        attachmentId: "att-1",
        controlEpoch: 1,
        data: "input",
      }).success,
    ).toBe(true);
    expect(
      HostWriteParamsSchema.safeParse({
        attachmentId: "att-1",
        controlEpoch: 1,
        ptyId: "pty-1",
        data: "input",
      }).success,
    ).toBe(false);
    expect(
      HostResizeParamsSchema.safeParse({
        attachmentId: "att-1",
        controlEpoch: 1.5,
        cols: 80,
        rows: 24,
      }).success,
    ).toBe(false);
    expect(
      HostResizeParamsSchema.safeParse({
        attachmentId: "att-1",
        controlEpoch: Number.MAX_SAFE_INTEGER + 1,
        cols: 80,
        rows: 24,
      }).success,
    ).toBe(false);
  });

  it("accepts only strict ordered replay events", () => {
    const ack = {
      subscribed: true,
      attachmentId: "att-host-1",
      controlEpoch: 1,
      role: "controller",
      ...PTY_IDENTITY,
      ...PTY_REF,
      pid: 42,
      cols: 5,
      rows: 4,
      exited: false,
      replay: {
        kind: "raw-complete",
        initialCols: 10,
        initialRows: 4,
        events: [
          { type: "data", data: "before" },
          { type: "resize", cols: 5, rows: 4 },
          { type: "data", data: "after" },
        ],
      },
    };

    expect(HostAttachAckSchema.safeParse(ack).success).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          ...ack.replay,
          events: [{ type: "resize", cols: 5, rows: 4, ptyId: "pty-1" }],
        },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: { ...ack.replay, events: [{ type: "resize", cols: 2.5, rows: 4 }] },
      }).success,
    ).toBe(false);
    expect(HostAttachAckSchema.safeParse({ ...ack, cols: 6 }).success).toBe(false);

    const liveReset = {
      ...ack,
      replay: {
        kind: "live-reset-recovery",
        initialCols: 5,
        initialRows: 4,
        events: [],
        resetData: "\x1bc\x1b[?2004h",
      },
    };
    expect(HostAttachAckSchema.safeParse(liveReset).success).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...liveReset,
        replay: {
          kind: "live-reset-recovery",
          initialCols: 5,
          initialRows: 4,
          events: [],
        },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...liveReset,
        replay: { ...liveReset.replay, resetData: "\x1b[?2004h" },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...liveReset,
        replay: { ...liveReset.replay, events: [{ type: "data", data: "partial" }] },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...liveReset,
        replay: { ...liveReset.replay, initialCols: 10 },
      }).success,
    ).toBe(false);
  });

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
    ).resolves.toEqual({ ...PTY_REF, pid: 4242 });
    await expect(client.list()).resolves.toEqual([]);
    client.dispose();
  });

  it("parses read-only Host handoff support evidence", async () => {
    const pty: HostRecoveryInventoryEntry = {
      kind: "agent",
      terminalTargetId: "target-1",
      worktreeId: "wt-1",
      projectId: "project-1",
      sessionId: "session-1",
      worktreePath: "/repo/wt-1",
      harnessProvider: "claude",
      ptyId: "pty-1",
      ptyInstanceId: "pty-instance-1",
      pid: 4242,
      alive: true,
      cols: 80,
      rows: 24,
      handoffSupport: { kind: "bridge-releasable" },
    };
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    startFakeRouter(server, {
      listPtys: [
        {
          kind: pty.kind,
          terminalTargetId: pty.terminalTargetId,
          worktreeId: pty.worktreeId,
          projectId: pty.projectId,
          sessionId: pty.sessionId,
          worktreePath: pty.worktreePath,
          harnessProvider: pty.harnessProvider,
          ptyId: pty.ptyId,
          ptyInstanceId: pty.ptyInstanceId,
          pid: pty.pid,
          alive: pty.alive,
          cols: pty.cols,
          rows: pty.rows,
        },
      ],
      recoveryPtys: [pty],
      buildIdentity: "1.0.0+station.host.revision-a",
    });
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });
    const listed = await client.list();
    expect(listed).toMatchObject([{ ptyId: "pty-1", ptyInstanceId: "pty-instance-1" }]);
    expect(listed[0]).not.toHaveProperty("handoffSupport");
    await expect(client.recoveryInventory?.()).resolves.toMatchObject({
      buildIdentity: "1.0.0+station.host.revision-a",
      ptys: [
        {
          ptyId: "pty-1",
          ptyInstanceId: "pty-instance-1",
          handoffSupport: { kind: "bridge-releasable" },
        },
      ],
    });
    client.dispose();
  });

  it("uses the composition-supplied UI context on operational requests", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    const identities: Array<NonNullable<ReturnType<typeof HostRequestSchema.parse>["client"]>> = [];
    startFakeRouter(server, { onClient: (client) => identities.push(client) });
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      uiContext: {
        uiRunId: "ui_11111111-1111-4111-8111-111111111111",
        rendererPid: 42,
        clientKind: "native_renderer",
      },
      connectionId: "conn-test",
      connect: async () => clientConn,
    });

    await client.list();

    expect(identities).toEqual([
      {
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: "test-build",
        uiRunId: "ui_11111111-1111-4111-8111-111111111111",
        rendererPid: 42,
        clientKind: "native_renderer",
        connectionId: "conn-test",
      },
    ]);
    client.dispose();
  });

  it("mints host_tool correlation without reading renderer environment", async () => {
    const previousRunId = process.env.STATION_UI_RUN_ID;
    const previousClientKind = process.env.STATION_UI_CLIENT_KIND;
    process.env.STATION_UI_RUN_ID = "ui_99999999-9999-4999-8999-999999999999";
    process.env.STATION_UI_CLIENT_KIND = "native_renderer";
    try {
      const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
      const identities: Array<NonNullable<ReturnType<typeof HostRequestSchema.parse>["client"]>> =
        [];
      startFakeRouter(server, { onClient: (client) => identities.push(client) });
      const client = createStationHostClient({
        socketPath: "unused",
        expectedBuildVersion: "test-build",
        connect: async () => clientConn,
      });

      await client.list();

      expect(identities[0]).toMatchObject({ clientKind: "host_tool" });
      expect(identities[0]?.uiRunId).not.toBe(process.env.STATION_UI_RUN_ID);
      client.dispose();
    } finally {
      if (previousRunId === undefined) delete process.env.STATION_UI_RUN_ID;
      else process.env.STATION_UI_RUN_ID = previousRunId;
      if (previousClientKind === undefined) delete process.env.STATION_UI_CLIENT_KIND;
      else process.env.STATION_UI_CLIENT_KIND = previousClientKind;
    }
  });

  it("sends client shutdown as a one-way notification", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    const shutdown = Promise.withResolvers<void>();
    startFakeRouter(server, { onShutdown: shutdown.resolve });
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });

    await client.list();
    client.dispose();

    await expect(shutdown.promise).resolves.toBeUndefined();
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
    const lifecycle: string[] = [];
    startFakeRouter(server, {
      buildVersion: "old-build",
      onRequest: (method) => {
        if (method === "host.spawn") {
          spawnRequests += 1;
        }
        if (
          method === "host.beginHandoff" ||
          method === "host.completeHandoff" ||
          method === "host.abortHandoff"
        ) {
          lifecycle.push(method);
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
    const begun = await client.beginHandoff("new-build", "processes");
    expect(begun.released).toEqual(["pty-1"]);
    await expect(client.completeHandoff()).resolves.toEqual({ stopping: true });
    await expect(client.abortHandoff()).resolves.toEqual({ adopted: ["pty-1"], failed: [] });
    // adoptRegistry is identity-bound and requires a reusable successor build.
    await expect(client.adoptRegistry(begun.manifest)).rejects.toMatchObject({
      code: "HOST_VERSION_INCOMPATIBLE",
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
    ).rejects.toMatchObject({ code: "HOST_VERSION_INCOMPATIBLE" });
    expect(spawnRequests).toBe(0);
    expect(lifecycle).toEqual(["host.beginHandoff", "host.completeHandoff", "host.abortHandoff"]);
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
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });
    await expect(client.health()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    client.dispose();
  });

  it("routes a frame sent immediately after a valid acknowledgement", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) continue;
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
        } else if (request.method === "host.attach") {
          server.send({ type: "data", ptyId: PTY_REF.ptyId, data: "before-ack" });
          server.send(hostSuccess(request.id, attachAck()));
          server.send({ type: "data", ptyId: PTY_REF.ptyId, data: "after-ack" });
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });

    const attachment = await client.attach(PTY_EXPECTATION, "controller");
    await expect(attachment.frames[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { data: "after-ack" },
    });
    client.dispose();
  });

  it("keeps the current sink routable when a replacement request fails", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    let attachCount = 0;
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) continue;
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
        } else if (request.method === "host.attach") {
          attachCount += 1;
          server.send(
            attachCount === 1
              ? hostSuccess(request.id, attachAck())
              : hostFailure(
                  request.id,
                  stationHostSafeError("HOST_ATTACH_GONE", "replacement failed"),
                ),
          );
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });
    const current = await client.attach(PTY_EXPECTATION, "controller");
    const iterator = current.frames[Symbol.asyncIterator]();

    await expect(client.attach(PTY_EXPECTATION, "controller")).rejects.toMatchObject({
      code: "HOST_ATTACH_GONE",
    });
    server.send({ type: "data", ptyId: PTY_REF.ptyId, data: "still-current" });
    await expect(iterator.next()).resolves.toMatchObject({ value: { data: "still-current" } });
    client.dispose();
  });

  it("a failed old detach cannot release a newer sink", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) continue;
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
        } else if (request.method === "host.attach") {
          server.send(hostSuccess(request.id, attachAck()));
        } else if (request.method === "host.detach") {
          server.send(
            hostFailure(request.id, stationHostSafeError("HOST_REQUEST_FAILED", "detach failed")),
          );
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });
    const old = await client.attach(PTY_EXPECTATION, "controller");
    const current = await client.attach(PTY_EXPECTATION, "controller");
    const iterator = current.frames[Symbol.asyncIterator]();

    await expect(old.detach()).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    server.send({ type: "data", ptyId: PTY_REF.ptyId, data: "newer" });
    await expect(iterator.next()).resolves.toMatchObject({ value: { data: "newer" } });
    client.dispose();
  });

  it("defaults attach to controller intent and binds claims and mutations to the Host capability", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    const operational: Array<{ method: string; params: unknown }> = [];
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) continue;
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
          continue;
        }
        operational.push({ method: request.method, params: request.params });
        if (request.method === "host.attach") {
          server.send(hostSuccess(request.id, attachAck({ role: "viewer", controlEpoch: 2 })));
        } else if (request.method === "host.claimControl") {
          server.send(
            hostSuccess(request.id, {
              attachmentId: "att-host-1",
              controlEpoch: 3,
              role: "controller",
            }),
          );
        } else {
          server.send(hostSuccess(request.id, { ok: true }));
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });

    const attachment = await client.attach(PTY_EXPECTATION, "controller");
    expect(attachment.controlState).toEqual({
      attachmentId: "att-host-1",
      controlEpoch: 2,
      role: "viewer",
    });
    await attachment.claimControl();
    await attachment.write("input");
    await attachment.resize(100, 30);

    expect(operational).toEqual([
      { method: "host.attach", params: { ...PTY_REF, intent: "controller" } },
      { method: "host.claimControl", params: { attachmentId: "att-host-1" } },
      {
        method: "host.write",
        params: { attachmentId: "att-host-1", controlEpoch: 3, data: "input" },
      },
      {
        method: "host.resize",
        params: { attachmentId: "att-host-1", controlEpoch: 3, cols: 100, rows: 30 },
      },
    ]);
    client.dispose();
  });

  it("routes targeted revocation and updates the attachment control state", async () => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) continue;
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
        } else if (request.method === "host.attach") {
          server.send(hostSuccess(request.id, attachAck()));
          await delay(0);
          server.send({
            type: "control-revoked",
            ptyId: PTY_REF.ptyId,
            attachmentId: "att-host-1",
            controlEpoch: 2,
          });
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });

    const attachment = await client.attach(PTY_EXPECTATION, "controller");
    await expect(attachment.frames[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: "control-revoked", controlEpoch: 2 },
    });
    expect(attachment.controlState).toMatchObject({ role: "viewer", controlEpoch: 2 });
    client.dispose();
  });

  it.each([
    ["terminalTargetId", "native:wrong"],
    ["ptyId", "pty-wrong"],
    ["ptyInstanceId", "ptyi-wrong"],
    ["kind", "aux"],
    ["worktreeId", "wt-wrong"],
    ["projectId", "proj-wrong"],
    ["sessionId", "ses-wrong"],
    ["worktreePath", "/repo/wrong"],
    ["harnessProvider", "codex"],
  ] as const)("rejects and detaches an acknowledgement with mismatched %s", async (field, value) => {
    const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
    const detached = Promise.withResolvers<void>();
    void (async () => {
      for await (const message of server.messages()) {
        if (HostClientShutdownNotificationSchema.safeParse(message).success) {
          continue;
        }
        const request = HostRequestSchema.parse(message);
        if (request.method === "host.health") {
          server.send(
            hostSuccess(request.id, {
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "test-build",
            }),
          );
        } else if (request.method === "host.attach") {
          server.send(
            hostSuccess(request.id, {
              subscribed: true,
              attachmentId: "att-host-1",
              controlEpoch: 1,
              role: "controller",
              ...PTY_IDENTITY,
              ...PTY_REF,
              [field]: value,
              pid: 42,
              cols: 80,
              rows: 24,
              exited: false,
              replay: {
                kind: "raw-complete",
                initialCols: 80,
                initialRows: 24,
                events: [],
              },
            }),
          );
        } else if (request.method === "host.detach") {
          detached.resolve();
          server.send(hostSuccess(request.id, { ok: true }));
        }
      }
    })();
    const client = createStationHostClient({
      socketPath: "unused",
      expectedBuildVersion: "test-build",
      connect: async () => clientConn,
    });

    await expect(client.attach(PTY_EXPECTATION, "controller")).rejects.toMatchObject({
      code: "HOST_ATTACHMENT_MISMATCH",
    });
    await expect(detached.promise).resolves.toBeUndefined();
    client.dispose();
  });
});
