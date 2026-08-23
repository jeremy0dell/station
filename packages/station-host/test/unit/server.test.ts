import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostAttachAck,
  HostAttachAckSchema,
  type HostAttachmentSource,
  type HostClientIdentity,
  type HostControlState,
  type HostFrame,
  type HostHandlers,
  HostResponseSchema,
  type HostServerLogger,
  HostSpawnParamsSchema,
  hostClientShutdownNotification,
  hostRequest,
  serveHostConnection,
} from "@station/host";
import { inMemoryNdjsonConnectionPair } from "@station/protocol";
import { describe, expect, it } from "vitest";

function ptyRef(ptyId: string) {
  return {
    terminalTargetId: `native:${ptyId}`,
    ptyId,
    ptyInstanceId: `instance-${ptyId}`,
  };
}

function ptyIdentity(terminalTargetId: string) {
  return {
    kind: "agent" as const,
    terminalTargetId,
    worktreeId: "wt-1",
    projectId: "proj-1",
    sessionId: "ses-1",
    worktreePath: "/repo/wt-1",
    harnessProvider: "claude",
  };
}

function ptyExpectation(ptyId: string) {
  const ref = ptyRef(ptyId);
  return { ...ptyIdentity(ref.terminalTargetId), ...ref };
}

function wire(handlers: Omit<HostHandlers, "hostIdentity">, logger: HostServerLogger = {}) {
  const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
  void serveHostConnection(
    server,
    {
      hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
      ...handlers,
      unary: {
        "host.health": () => ({
          ok: true,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: "test-build",
        }),
        ...handlers.unary,
      },
    },
    logger,
  );
  return createStationHostClient({
    socketPath: "unused",
    expectedBuildVersion: "test-build",
    connect: async () => clientConn,
  });
}

/** A pull-based frame stream a test can feed and end. */
function controllableStream(onReturn: () => void = () => undefined) {
  const queue: HostFrame[] = [];
  const waiters: Array<(r: IteratorResult<HostFrame>) => void> = [];
  let ended = false;
  const drain = () => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      const next = queue.shift();
      waiter(next === undefined ? { done: true, value: undefined } : { done: false, value: next });
    }
  };
  return {
    push: (frame: HostFrame) => {
      queue.push(frame);
      drain();
    },
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<HostFrame>>((resolve) => {
            const next = queue.shift();
            if (next !== undefined) resolve({ done: false, value: next });
            else if (ended) resolve({ done: true, value: undefined });
            else waiters.push(resolve);
          }),
        return: () => {
          ended = true;
          onReturn();
          drain();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    },
    isEnded: () => ended,
  };
}

function attachmentSource(
  ack: HostAttachAck,
  frames: AsyncIterable<HostFrame>,
  captureDurationMs = 0,
): HostAttachmentSource {
  let state = {
    attachmentId: ack.attachmentId,
    controlEpoch: ack.controlEpoch,
    role: ack.role,
  };
  return {
    ack,
    frames,
    captureDurationMs,
    get controlState() {
      return state;
    },
    claimControl() {
      state = { ...state, controlEpoch: state.controlEpoch + 1, role: "controller" };
      return state;
    },
    write() {},
    resize() {},
  };
}

const TEST_CLIENT_IDENTITY: HostClientIdentity = {
  protocolVersion: HOST_PROTOCOL_VERSION,
  buildVersion: "test-build",
  uiRunId: "ui_11111111-1111-4111-8111-111111111111",
  rendererPid: 100,
  clientKind: "native_renderer",
  connectionId: "conn-one",
};

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

describe("serveHostConnection", () => {
  it("rejects operational requests without correlation identity", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    void serveHostConnection(server, {
      hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
      unary: { "host.list": () => ({ ptys: [] }) },
    });

    client.send(hostRequest("legacy", "host.list"));
    for await (const message of client.messages()) {
      expect(HostResponseSchema.parse(message)).toMatchObject({
        id: "legacy",
        ok: false,
        error: { code: "HOST_CLIENT_IDENTITY_MISMATCH" },
      });
      break;
    }
    client.close();
  });

  it("allows exact convergence reads and handoff lifecycle methods without correlation identity", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    const calls: string[] = [];
    void serveHostConnection(server, {
      hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
      unary: {
        "host.recoveryInventory": () => {
          calls.push("recovery-inventory");
          return { buildIdentity: "incumbent-identity", ptys: [] };
        },
        "host.beginHandoff": () => {
          calls.push("begin");
          return {
            manifest: {},
            fidelity: "processes",
            released: ["pty-1"],
            skipped: [],
          };
        },
        "host.completeHandoff": () => {
          calls.push("complete");
          return { stopping: true };
        },
        "host.abortHandoff": () => {
          calls.push("abort");
          return { adopted: [], failed: [] };
        },
        "host.adoptRegistry": () => {
          calls.push("adopt");
          return { adopted: [], failed: [] };
        },
      },
    });
    const responses = client.messages()[Symbol.asyncIterator]();

    client.send(hostRequest("recovery", "host.recoveryInventory"));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "recovery",
      ok: true,
      result: { buildIdentity: "incumbent-identity", ptys: [] },
    });
    client.send(
      hostRequest("begin", "host.beginHandoff", {
        requestingBuildVersion: "next",
        fidelity: "processes",
      }),
    );
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "begin",
      ok: true,
    });
    client.send(hostRequest("complete", "host.completeHandoff"));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "complete",
      ok: true,
    });
    client.send(hostRequest("abort", "host.abortHandoff"));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "abort",
      ok: true,
    });
    // adoptRegistry is identity-bound, not a lifecycle exemption.
    client.send(hostRequest("adopt", "host.adoptRegistry", { manifest: {} }));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "adopt",
      ok: false,
      error: { code: "HOST_CLIENT_IDENTITY_MISMATCH" },
    });
    expect(calls).toEqual(["recovery-inventory", "begin", "complete", "abort"]);
    client.close();
  });

  it("classifies build compatibility separately from correlation changes", async () => {
    const identity = TEST_CLIENT_IDENTITY;
    const { client, server } = inMemoryNdjsonConnectionPair();
    void serveHostConnection(server, {
      hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
      unary: { "host.list": () => ({ ptys: [] }) },
    });
    const responses = client.messages()[Symbol.asyncIterator]();

    client.send(hostRequest("first", "host.list", undefined, identity));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "first",
      ok: true,
    });
    client.send(
      hostRequest("changed", "host.list", undefined, {
        ...identity,
        uiRunId: "ui_22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "changed",
      ok: false,
      error: { code: "HOST_CLIENT_IDENTITY_MISMATCH" },
    });
    client.send(
      hostRequest("old-protocol", "host.list", undefined, {
        ...identity,
        protocolVersion: 5,
      }),
    );
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "old-protocol",
      ok: false,
      error: { code: "HOST_VERSION_INCOMPATIBLE" },
    });
    client.close();
  });

  it("does not answer the one-way client shutdown notification", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    const lifecycle: Array<Parameters<NonNullable<HostServerLogger["onLifecycle"]>>[0]> = [];
    void serveHostConnection(
      server,
      {
        hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
        unary: { "host.list": () => ({ ptys: [] }) },
      },
      { onLifecycle: (event) => lifecycle.push(event) },
    );
    const responses = client.messages()[Symbol.asyncIterator]();
    client.send(hostRequest("bind", "host.list", undefined, TEST_CLIENT_IDENTITY));
    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({ ok: true });

    client.send(hostClientShutdownNotification(TEST_CLIENT_IDENTITY));
    expect(await Promise.race([responses.next(), delay(10)])).toBe("timeout");
    client.close();
    await delay(0);
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "host.client.detached", reason: "client_shutdown" }),
      ]),
    );
  });

  it("removes client-shutdown authority before synchronously ending its attachment", async () => {
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    let state: HostControlState = {
      attachmentId: "pending",
      controlEpoch: 1,
      role: "controller",
    };
    const stream = controllableStream(() => {
      state = { ...state, role: "viewer" };
    });
    const { client, server } = inMemoryNdjsonConnectionPair();
    void serveHostConnection(
      server,
      {
        hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
        attach: (params, attachmentId) => {
          state = { ...state, attachmentId };
          return {
            ack: {
              subscribed: true,
              ...state,
              ...ptyIdentity(params.terminalTargetId),
              terminalTargetId: params.terminalTargetId,
              ptyId: params.ptyId,
              ptyInstanceId: params.ptyInstanceId,
              pid: 7,
              cols: 80,
              rows: 24,
              exited: false,
              replay: {
                kind: "raw-complete",
                initialCols: 80,
                initialRows: 24,
                events: [],
              },
            },
            frames: stream.frames,
            captureDurationMs: 0,
            get controlState() {
              return state;
            },
            claimControl: () => state,
            write() {},
            resize() {},
          };
        },
      },
      { onEvent: (event, attributes) => events.push({ event, attributes }) },
    );
    const responses = client.messages()[Symbol.asyncIterator]();
    client.send(
      hostRequest(
        "attach",
        "host.attach",
        { ...ptyRef("p1"), intent: "controller" },
        TEST_CLIENT_IDENTITY,
      ),
    );
    const attachResponse = HostResponseSchema.parse((await responses.next()).value);
    expect(attachResponse.ok).toBe(true);
    const attachment = HostAttachAckSchema.parse(attachResponse.ok ? attachResponse.result : {});

    client.send(hostClientShutdownNotification(TEST_CLIENT_IDENTITY));
    client.send(
      hostRequest(
        "late-write",
        "host.write",
        { attachmentId: attachment.attachmentId, controlEpoch: 1, data: "hidden" },
        TEST_CLIENT_IDENTITY,
      ),
    );

    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "late-write",
      ok: false,
      error: { code: "HOST_CONTROL_REVOKED" },
    });
    expect(stream.isEnded()).toBe(true);
    await expect
      .poll(() => events.some(({ event }) => event === "host.attachment.detached"))
      .toBe(true);
    expect(events).toContainEqual({
      event: "host.attachment.detached",
      attributes: {
        ptyId: "p1",
        attachmentId: attachment.attachmentId,
        controlEpoch: 1,
        role: "controller",
        reason: "client_shutdown",
      },
    });
    client.close();
  });

  it("dispatches a registered unary method and returns its result", async () => {
    const client = wire({
      unary: { "host.health": () => ({ ok: true, protocolVersion: 1 }) },
    });
    await expect(client.health()).resolves.toEqual({ ok: true, protocolVersion: 1 });
    client.dispose();
  });

  it("answers an unknown method with a classified HOST_BAD_REQUEST", async () => {
    const client = wire({ unary: {} });
    await expect(client.focus("pty-x")).rejects.toMatchObject({
      tag: "TerminalProviderError",
      provider: "native",
      code: "HOST_BAD_REQUEST",
    });
    client.dispose();
  });

  it("carries the optional generic output compatibility policy through host.spawn", async () => {
    let received: unknown;
    const client = wire({
      unary: {
        "host.spawn": (params) => {
          received = HostSpawnParamsSchema.parse(params);
          return { ...ptyRef("p1"), pid: 7 };
        },
      },
    });

    await client.spawn({
      terminalTargetId: "native:wt-1",
      worktreeId: "wt-1",
      projectId: "proj-1",
      sessionId: "ses-1",
      worktreePath: "/repo/wt-1",
      harnessProvider: "codex",
      command: "codex",
      args: [],
      cwd: "/repo/wt-1",
      cols: 80,
      rows: 24,
      outputCompatibility: "top-region-scrollback",
    });

    expect(received).toMatchObject({ outputCompatibility: "top-region-scrollback" });
    client.dispose();
  });

  it("classifies a throwing handler as a SafeError without dropping the connection", async () => {
    const client = wire({
      unary: {
        "host.focus": () => {
          throw new Error("kaboom");
        },
      },
    });
    await expect(client.focus("pty-x")).rejects.toMatchObject({ code: "HOST_REQUEST_FAILED" });
    // Connection survives a handler fault: a subsequent request still works.
    await expect(client.health()).resolves.toEqual({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "test-build",
    });
    client.dispose();
  });

  it("acks the attach snapshot, streams live frames, and retains reasoned host.detach identity", async () => {
    const stream = controllableStream();
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const lifecycle: Array<Parameters<NonNullable<HostServerLogger["onLifecycle"]>>[0]> = [];
    const client = wire(
      {
        attach: (_params, attachmentId) =>
          attachmentSource(
            {
              subscribed: true,
              attachmentId,
              controlEpoch: 1,
              role: "controller",
              ...ptyIdentity(ptyRef("p1").terminalTargetId),
              ...ptyRef("p1"),
              pid: 7,
              cols: 100,
              rows: 30,
              exited: false,
              replay: {
                kind: "raw-complete",
                initialCols: 80,
                initialRows: 24,
                events: [
                  { type: "data", data: "snap" },
                  { type: "resize", cols: 100, rows: 30 },
                  { type: "data", data: "after-resize" },
                ],
              },
            },
            stream.frames,
            12.5,
          ),
      },
      {
        onEvent: (event, attributes) => events.push({ event, attributes }),
        onLifecycle: (event) => lifecycle.push(event),
      },
    );
    const attachment = await client.attach(ptyExpectation("p1"), "controller");
    expect(attachment.ack.replay.events).toEqual([
      { type: "data", data: "snap" },
      { type: "resize", cols: 100, rows: 30 },
      { type: "data", data: "after-resize" },
    ]);
    expect(events).toContainEqual({
      event: "agent.attach",
      attributes: {
        ptyId: "p1",
        replayKind: "raw-complete",
        replayEntries: 3,
        replayBytes: 16,
        cols: 100,
        rows: 30,
        captureDurationMs: 12.5,
      },
    });
    expect(events).toContainEqual({
      event: "host.attachment.attached",
      attributes: {
        ptyId: "p1",
        attachmentId: expect.stringMatching(/^att_/),
        controlEpoch: 1,
        role: "controller",
        reason: "controller",
      },
    });

    const iterator = attachment.frames[Symbol.asyncIterator]();
    stream.push({ type: "data", ptyId: "p1", data: "live" });
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId: "p1", data: "live" },
    });

    await attachment.detach();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await delay(0);
    expect(events).toContainEqual({ event: "agent.detach", attributes: { ptyId: "p1" } });
    expect(events).toContainEqual({
      event: "host.attachment.detached",
      attributes: {
        ptyId: "p1",
        attachmentId: attachment.ack.attachmentId,
        controlEpoch: 1,
        role: "controller",
        reason: "explicit_detach",
      },
    });
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "host.client.attached",
          connectionId: expect.stringMatching(/^conn_/),
        }),
        expect.objectContaining({
          kind: "host.attachment.attached",
          attachmentId: attachment.ack.attachmentId,
          ptyId: "p1",
        }),
        expect.objectContaining({
          kind: "host.attachment.detached",
          attachmentId: attachment.ack.attachmentId,
          reason: "explicit_detach",
        }),
      ]),
    );
    client.dispose();
    await delay(10);
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "host.client.detached",
          reason: "client_shutdown",
        }),
      ]),
    );
  });

  it("resolves control claims and mutations only through the connection attachment registry", async () => {
    const stream = controllableStream();
    const mutations: unknown[] = [];
    let state: HostControlState = {
      attachmentId: "pending",
      controlEpoch: 0,
      role: "viewer",
    };
    const client = wire({
      attach: (params, attachmentId) => {
        state = { attachmentId, controlEpoch: 0, role: "viewer" };
        return {
          ack: {
            subscribed: true,
            ...state,
            ...ptyIdentity(params.terminalTargetId),
            terminalTargetId: params.terminalTargetId,
            ptyId: params.ptyId,
            ptyInstanceId: params.ptyInstanceId,
            pid: 7,
            cols: 80,
            rows: 24,
            exited: false,
            replay: {
              kind: "raw-complete",
              initialCols: 80,
              initialRows: 24,
              events: [],
            },
          },
          frames: stream.frames,
          captureDurationMs: 0,
          get controlState() {
            return state;
          },
          claimControl() {
            state = { ...state, controlEpoch: 1, role: "controller" };
            return state;
          },
          write(controlEpoch, data) {
            mutations.push({ kind: "write", controlEpoch, data });
          },
          resize(controlEpoch, cols, rows) {
            mutations.push({ kind: "resize", controlEpoch, cols, rows });
          },
        };
      },
    });

    const attachment = await client.attach(ptyExpectation("p1"), "viewer");
    await attachment.claimControl();
    await attachment.write("input");
    await attachment.resize(100, 30);

    expect(mutations).toEqual([
      {
        kind: "write",
        controlEpoch: 1,
        data: "input",
      },
      {
        kind: "resize",
        controlEpoch: 1,
        cols: 100,
        rows: 30,
      },
    ]);
    client.dispose();
  });

  it("rejects unknown and cross-connection attachment capabilities as control revoked", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    void serveHostConnection(server, {
      hostIdentity: { protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "test-build" },
      unary: { "host.list": () => ({ ptys: [] }) },
    });
    const responses = client.messages()[Symbol.asyncIterator]();
    client.send(hostRequest("bind", "host.list", undefined, TEST_CLIENT_IDENTITY));
    await responses.next();
    client.send(
      hostRequest(
        "write",
        "host.write",
        { attachmentId: "att-from-another-connection", controlEpoch: 1, data: "hidden" },
        TEST_CLIENT_IDENTITY,
      ),
    );

    expect(HostResponseSchema.parse((await responses.next()).value)).toMatchObject({
      id: "write",
      ok: false,
      error: { code: "HOST_CONTROL_REVOKED" },
    });
    client.close();
  });

  it("strictly distinguishes raw, semantic, and control-only live-reset replay", () => {
    const ack = {
      subscribed: true as const,
      attachmentId: "att-test",
      controlEpoch: 1,
      role: "controller" as const,
      ...ptyIdentity(ptyRef("p1").terminalTargetId),
      ...ptyRef("p1"),
      pid: 7,
      cols: 100,
      rows: 30,
      exited: false,
    };

    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "raw-complete",
          initialCols: 80,
          initialRows: 24,
          events: [{ type: "resize", cols: 100, rows: 30 }],
        },
      }).success,
    ).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "semantic-truncation-recovery",
          initialCols: 100,
          initialRows: 30,
          events: [{ type: "data", data: "\x1bcsemantic" }],
        },
      }).success,
    ).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "semantic-truncation-recovery",
          initialCols: 80,
          initialRows: 24,
          events: [{ type: "resize", cols: 100, rows: 30 }],
        },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "live-reset-recovery",
          initialCols: 100,
          initialRows: 30,
          events: [],
          resetData: "\x1bc\x1b[?1h",
        },
      }).success,
    ).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "live-reset-recovery",
          initialCols: 100,
          initialRows: 30,
          events: [],
          resetData: "not-ris",
        },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "live-reset-recovery",
          initialCols: 100,
          initialRows: 30,
          events: [{ type: "data", data: "incomplete" }],
          resetData: "\x1bc",
        },
      }).success,
    ).toBe(false);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "raw-complete",
          initialCols: 100,
          initialRows: 30,
          events: [],
          chunks: [],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps simultaneous attach streams isolated by PTY id", async () => {
    const streams = new Map<string, ReturnType<typeof controllableStream>>();
    const client = wire({
      attach: (params, attachmentId) => {
        const stream = controllableStream();
        streams.set(params.ptyId, stream);
        return attachmentSource(
          {
            subscribed: true,
            attachmentId,
            controlEpoch: 1,
            role: "controller",
            ...ptyIdentity(params.terminalTargetId),
            terminalTargetId: params.terminalTargetId,
            ptyId: params.ptyId,
            ptyInstanceId: params.ptyInstanceId,
            pid: params.ptyId === "p1" ? 7 : 8,
            cols: 80,
            rows: 24,
            exited: false,
            replay: {
              kind: "raw-complete",
              initialCols: 80,
              initialRows: 24,
              events: [{ type: "data", data: `snap-${params.ptyId}` }],
            },
          },
          stream.frames,
        );
      },
    });

    const first = await client.attach(ptyExpectation("p1"), "controller");
    const second = await client.attach(ptyExpectation("p2"), "controller");
    expect(first.ack.replay.events).toEqual([{ type: "data", data: "snap-p1" }]);
    expect(second.ack.replay.events).toEqual([{ type: "data", data: "snap-p2" }]);

    const firstIterator = first.frames[Symbol.asyncIterator]();
    const secondIterator = second.frames[Symbol.asyncIterator]();
    const firstPending = firstIterator.next();
    streams.get("p2")?.push({ type: "data", ptyId: "p2", data: "two" });

    await expect(Promise.race([firstPending, delay(20)])).resolves.toBe("timeout");
    await expect(secondIterator.next()).resolves.toEqual({
      done: false,
      value: { type: "data", ptyId: "p2", data: "two" },
    });

    streams.get("p1")?.push({ type: "data", ptyId: "p1", data: "one" });
    await expect(firstPending).resolves.toEqual({
      done: false,
      value: { type: "data", ptyId: "p1", data: "one" },
    });

    await first.detach();
    await expect(firstIterator.next()).resolves.toEqual({ done: true, value: undefined });

    const secondStillOpen = secondIterator.next();
    streams.get("p2")?.push({ type: "data", ptyId: "p2", data: "still-open" });
    await expect(secondStillOpen).resolves.toEqual({
      done: false,
      value: { type: "data", ptyId: "p2", data: "still-open" },
    });
    await second.detach();
    client.dispose();
  });

  it("keeps replacement routing owned by the latest attachment attempt", async () => {
    const streams: ReturnType<typeof controllableStream>[] = [];
    const client = wire({
      attach: (params, attachmentId) => {
        const stream = controllableStream();
        streams.push(stream);
        return attachmentSource(
          {
            subscribed: true,
            attachmentId,
            controlEpoch: 1,
            role: "controller",
            ...ptyIdentity(params.terminalTargetId),
            terminalTargetId: params.terminalTargetId,
            ptyId: params.ptyId,
            ptyInstanceId: params.ptyInstanceId,
            pid: 7,
            cols: 80,
            rows: 24,
            exited: false,
            replay: {
              kind: "raw-complete",
              initialCols: 80,
              initialRows: 24,
              events: [],
            },
          },
          stream.frames,
        );
      },
    });

    const first = await client.attach(ptyExpectation("p1"), "controller");
    const firstIterator = first.frames[Symbol.asyncIterator]();
    const second = await client.attach(ptyExpectation("p1"), "controller");
    const secondIterator = second.frames[Symbol.asyncIterator]();

    await expect(firstIterator.next()).resolves.toEqual({ done: true, value: undefined });
    await first.detach();
    await firstIterator.return?.();

    const next = secondIterator.next();
    streams[1]?.push({ type: "data", ptyId: "p1", data: "latest" });
    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "data", ptyId: "p1", data: "latest" },
    });

    await second.detach();
    client.dispose();
  });

  it("rejects a mismatched handler acknowledgement before registering the stream", async () => {
    const stream = controllableStream();
    const client = wire({
      attach: (params, attachmentId) =>
        attachmentSource(
          {
            subscribed: true,
            attachmentId,
            controlEpoch: 1,
            role: "controller",
            ...ptyIdentity(params.terminalTargetId),
            terminalTargetId: params.terminalTargetId,
            ptyId: params.ptyId,
            ptyInstanceId: "wrong-instance",
            pid: 7,
            cols: 80,
            rows: 24,
            exited: false,
            replay: {
              kind: "raw-complete",
              initialCols: 80,
              initialRows: 24,
              events: [],
            },
          },
          stream.frames,
        ),
    });

    await expect(client.attach(ptyExpectation("p1"), "controller")).rejects.toMatchObject({
      code: "HOST_ATTACHMENT_MISMATCH",
    });
    expect(stream.isEnded()).toBe(true);
    client.dispose();
  });

  it("serves concurrent in-flight requests over one multiplexed connection", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = wire({
      unary: {
        // host.list blocks until released; host.health must still answer first.
        "host.list": async () => {
          await gate;
          return { ptys: [] };
        },
        "host.health": () => ({
          ok: true,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: "test-build",
        }),
      },
    });
    const listPromise = client.list();
    await expect(client.health()).resolves.toEqual({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "test-build",
    });
    release?.();
    await expect(listPromise).resolves.toEqual([]);
    client.dispose();
  });
});
