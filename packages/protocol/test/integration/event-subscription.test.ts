import type { EventFilter, StationEvent } from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  connectUnixSocket,
  createObserverClient,
  listenUnixSocket,
  startProtocolServer,
} from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import {
  createFakeObserverApi,
  ids,
  protocolTestNow,
  stream,
  waitFor,
} from "../support/fixtures.js";

describe("protocol event subscriptions", () => {
  it("streams command and hook events to subscribers", async () => {
    const { socketPath } = await createTempSocketPath();
    const events: StationEvent[] = [
      {
        type: "command.accepted",
        commandId: "cmd_1",
        command: { type: "observer.reconcile", payload: { reason: "subscription-test" } },
      },
      {
        type: "providerHook.ingested",
        at: protocolTestNow,
        hookId: "hook_1",
        provider: "worktrunk",
        event: "worktree.created",
      },
    ];
    let observedFilter: EventFilter | undefined;
    const api = {
      ...createFakeObserverApi(),
      subscribe: (filter?: EventFilter) => {
        observedFilter = filter;
        return stream(events);
      },
    };
    const server = await startProtocolServer({ socketPath, api });
    const client = createObserverClient({ socketPath, requestId: ids("sub") });

    const iterator = client
      .subscribe({ type: ["command.accepted", "providerHook.ingested"] })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "command.accepted", commandId: "cmd_1" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "providerHook.ingested", hookId: "hook_1" },
    });
    await iterator.return?.();

    expect(observedFilter).toEqual({ type: ["command.accepted", "providerHook.ingested"] });
    await server.close();
  });

  it("rejects retired hook event filters at the subscribe boundary", async () => {
    const { socketPath } = await createTempSocketPath();
    let observedFilter: EventFilter | undefined;
    const api = {
      ...createFakeObserverApi(),
      subscribe: (filter?: EventFilter) => {
        observedFilter = filter;
        return stream([]);
      },
    };
    const server = await startProtocolServer({ socketPath, api });
    const connection = await connectUnixSocket(socketPath, { timeoutMs: 500 });

    try {
      connection.send({
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "retired_sub",
        method: "events.subscribe",
        params: {
          type: ["hook.ingested", "providerHook.ingested", "hook.spoolDrained"],
        },
      });
      const iterator = connection.messages()[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          id: "retired_sub",
          error: { message: "Observer protocol method failed." },
        },
      });

      expect(observedFilter).toBeUndefined();
    } finally {
      connection.close();
      await server.close();
    }
  });

  it("cleans up a blocked subscriber when the socket disconnects", async () => {
    const { socketPath } = await createTempSocketPath();
    let releaseNextStarted: () => void = () => undefined;
    const nextStarted = new Promise<void>((resolve) => {
      releaseNextStarted = resolve;
    });
    let returned = false;
    const blockedEvents: AsyncIterable<StationEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          releaseNextStarted();
          return new Promise<IteratorResult<StationEvent>>(() => undefined);
        },
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      }),
    };
    const api = {
      ...createFakeObserverApi(),
      subscribe: () => blockedEvents,
    };
    const server = await startProtocolServer({ socketPath, api });
    const connection = await connectUnixSocket(socketPath, { timeoutMs: 500 });

    try {
      connection.send({
        schemaVersion: STATION_SCHEMA_VERSION,
        jsonrpc: "2.0",
        id: "blocked_sub",
        method: "events.subscribe",
      });
      const iterator = connection.messages()[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          id: "blocked_sub",
          result: { subscribed: true },
        },
      });
      await nextStarted;

      connection.close();
      await waitFor(() => returned);
    } finally {
      connection.close();
      await server.close();
    }
  });

  it("times out and closes the socket when subscription ack hangs", async () => {
    const { socketPath } = await createTempSocketPath();
    let closed = false;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        await connection.closed;
        closed = true;
      },
    });
    const client = createObserverClient({ socketPath, timeoutMs: 10, requestId: ids("hang") });
    const iterator = client.subscribe()[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).rejects.toMatchObject({
        tag: "TimeoutError",
        code: "PROTOCOL_SUBSCRIBE_TIMEOUT",
      });
      await waitFor(() => closed);
    } finally {
      await iterator.return?.();
      await server.close();
    }
  });

  it("closes the socket when the subscription iterator is returned", async () => {
    const { socketPath } = await createTempSocketPath();
    let releaseRequestReceived: () => void = () => undefined;
    const requestReceived = new Promise<void>((resolve) => {
      releaseRequestReceived = resolve;
    });
    let closed = false;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        const messages = connection.messages()[Symbol.asyncIterator]();
        await messages.next();
        connection.send({
          schemaVersion: STATION_SCHEMA_VERSION,
          jsonrpc: "2.0",
          id: "cleanup_1",
          result: { subscribed: true },
        });
        releaseRequestReceived();
        await connection.closed;
        closed = true;
      },
    });
    const client = createObserverClient({ socketPath, requestId: ids("cleanup") });
    const iterator = client.subscribe()[Symbol.asyncIterator]();
    const next = iterator.next();

    try {
      await requestReceived;
      await iterator.return?.();
      await waitFor(() => closed);
      await expect(next).resolves.toMatchObject({ done: true });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed event envelopes and closes the socket", async () => {
    const { socketPath } = await createTempSocketPath();
    let closed = false;
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        const messages = connection.messages()[Symbol.asyncIterator]();
        await messages.next();
        connection.send({
          schemaVersion: STATION_SCHEMA_VERSION,
          jsonrpc: "2.0",
          id: "bad_1",
          result: { subscribed: true },
        });
        connection.send({
          schemaVersion: STATION_SCHEMA_VERSION,
          event: { type: "not.an.event" },
        });
        await connection.closed;
        closed = true;
      },
    });
    const client = createObserverClient({ socketPath, requestId: ids("bad") });
    const iterator = client.subscribe()[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).rejects.toMatchObject({
        tag: "ProtocolError",
        code: "PROTOCOL_EVENT_VALIDATION_FAILED",
        message: "Observer protocol event failed validation.",
        hint: expect.stringContaining("different STATION build"),
      });
      await waitFor(() => closed);
    } finally {
      await iterator.return?.();
      await server.close();
    }
  });
});
