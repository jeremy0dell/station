import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostFrame,
  type HostHandlers,
  HostResponseSchema,
  hostRequest,
  serveHostConnection,
} from "@station/host";
import { inMemoryNdjsonConnectionPair } from "@station/protocol";
import { describe, expect, it } from "vitest";

function wire(handlers: Omit<HostHandlers, "hostIdentity">) {
  const { client: clientConn, server } = inMemoryNdjsonConnectionPair();
  void serveHostConnection(server, {
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
  });
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
    const client = wire({
      attach: () => ({
        ack: {
          subscribed: true,
          ptyId: "p1",
          pid: 7,
          cols: 80,
          rows: 24,
          exited: false,
          scrollback: ["snap"],
          truncated: false,
        },
        frames: stream.frames,
      }),
    });
    const attachment = await client.attach("p1");
    expect(attachment.ack.scrollback).toEqual(["snap"]);

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
            scrollback: [`snap-${params.ptyId}`],
            truncated: false,
          },
          frames: stream.frames,
        };
      },
    });

    const first = await client.attach("p1");
    const second = await client.attach("p2");
    expect(first.ack.scrollback).toEqual(["snap-p1"]);
    expect(second.ack.scrollback).toEqual(["snap-p2"]);

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
