import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  HostAttachAckSchema,
  type HostFrame,
  type HostHandlers,
  HostResponseSchema,
  type HostServerLogger,
  HostSpawnParamsSchema,
  hostRequest,
  serveHostConnection,
} from "@station/host";
import { inMemoryNdjsonConnectionPair } from "@station/protocol";
import { describe, expect, it } from "vitest";

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
function controllableStream() {
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
          drain();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    },
  };
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

describe("serveHostConnection", () => {
  it("rejects legacy operational requests without protocol and build identity", async () => {
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
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      break;
    }
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
          return { ptyId: "p1", pid: 7 };
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

  it("acks the attach snapshot, streams live frames, and ends on host.detach", async () => {
    const stream = controllableStream();
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const client = wire(
      {
        attach: () => ({
          ack: {
            subscribed: true,
            ptyId: "p1",
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
          frames: stream.frames,
          captureDurationMs: 12.5,
        }),
      },
      {
        onEvent: (event, attributes) => events.push({ event, attributes }),
      },
    );
    const attachment = await client.attach("p1");
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

    const iterator = attachment.frames[Symbol.asyncIterator]();
    stream.push({ type: "data", ptyId: "p1", data: "live" });
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId: "p1", data: "live" },
    });

    await attachment.detach();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    client.dispose();
  });

  it("strictly distinguishes raw, semantic, and control-only live-reset replay", () => {
    const ack = {
      subscribed: true as const,
      ptyId: "p1",
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
          events: [
            { type: "data", data: "\x1bcsemantic" },
            { type: "semantic-copy", normal: [], alternate: [] },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      HostAttachAckSchema.safeParse({
        ...ack,
        replay: {
          kind: "raw-complete",
          initialCols: 100,
          initialRows: 30,
          events: [{ type: "semantic-copy", normal: [], alternate: [] }],
        },
      }).success,
    ).toBe(false);
    for (const events of [
      [{ type: "resize", cols: 100, rows: 30 }],
      [{ type: "data", data: "missing-sidecar" }],
      [
        { type: "semantic-copy", normal: [], alternate: [] },
        { type: "data", data: "out-of-order" },
      ],
      [
        { type: "data", data: "duplicate" },
        { type: "semantic-copy", normal: [], alternate: [] },
        { type: "semantic-copy", normal: [], alternate: [] },
      ],
      [
        { type: "data", data: "bad-count" },
        {
          type: "semantic-copy",
          normal: [{ row: 0, leadingColumns: 0, separatorSpaces: 1025 }],
          alternate: [],
        },
      ],
      [
        { type: "data", data: "duplicate-row" },
        {
          type: "semantic-copy",
          normal: [
            { row: 0, leadingColumns: 0, separatorSpaces: 0 },
            { row: 0, leadingColumns: 1, separatorSpaces: 1 },
          ],
          alternate: [],
        },
      ],
    ]) {
      expect(
        HostAttachAckSchema.safeParse({
          ...ack,
          replay: {
            kind: "semantic-truncation-recovery",
            initialCols: 100,
            initialRows: 30,
            events,
          },
        }).success,
      ).toBe(false);
    }
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
      attach: (params) => {
        const stream = controllableStream();
        streams.set(params.ptyId, stream);
        return {
          ack: {
            subscribed: true,
            ptyId: params.ptyId,
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
          frames: stream.frames,
          captureDurationMs: 0,
        };
      },
    });

    const first = await client.attach("p1");
    const second = await client.attach("p2");
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
