import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createTerminalGateway, requestGateway } from "../../src/terminalGateway.js";
import type { GatewayConfig } from "../../src/terminalProtocol.js";

const fake = vi.hoisted(() => ({
  epoch: 0,
  writes: [] as string[],
  operations: [] as string[],
  attaches: 0,
  beforeWrite: async () => {},
  replay: "history",
}));
vi.mock("@station/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@station/host")>();
  return {
    ...actual,
    createStationHostClient: () => ({
      dispose() {},
      async attach(identity: GatewayConfig["identity"]) {
        const epoch = ++fake.epoch;
        fake.attaches++;
        let detached = false;
        let release!: () => void;
        const closed = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ack: {
            ...identity,
            subscribed: true,
            attachmentId: randomUUID(),
            controlEpoch: epoch,
            role: "controller",
            pid: 42,
            cols: 80,
            rows: 24,
            exited: false,
            replay: {
              kind: "raw-complete",
              initialCols: 80,
              initialRows: 24,
              events: [{ type: "data", data: fake.replay }],
            },
          },
          frames: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  await closed;
                  return { done: true, value: undefined };
                },
              };
            },
          },
          async write(data: string) {
            await fake.beforeWrite();
            if (detached || epoch !== fake.epoch) throw new Error("Revoked");
            fake.writes.push(data);
            fake.operations.push(`input:${data}`);
          },
          async resize(cols: number, rows: number) {
            if (detached || epoch !== fake.epoch) throw new Error("Revoked");
            fake.operations.push(`resize:${cols}:${rows}`);
          },
          async detach() {
            detached = true;
            release();
          },
        };
      },
    }),
  };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  fake.writes = [];
  fake.operations = [];
  fake.attaches = 0;
  fake.beforeWrite = async () => {};
  fake.replay = "history";
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "e2b-gateway-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config: GatewayConfig = {
    version: 1,
    execution: "ses_local",
    hostSocket: join(root, "host.sock"),
    controlSocket: join(root, "control.sock"),
    port,
    identity: {
      kind: "agent",
      terminalTargetId: "target",
      worktreeId: "wt",
      projectId: "project",
      sessionId: "ses_remote",
      worktreePath: "/worktree",
      harnessProvider: "codex",
      ptyId: "pty",
      ptyInstanceId: "instance",
    },
  };
  const gateway = await createTerminalGateway(config);
  cleanup.push(() => gateway.dispose());
  const grant = () =>
    requestGateway(config.controlSocket, {
      type: "grant",
      execution: config.execution,
      identity: config.identity,
    });
  const connect = async (ticket: string, identity = config.identity) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on("error", () => {});
    cleanup.push(async () => {
      socket.terminate();
    });
    await once(socket, "open");
    const response = Promise.race([
      once(socket, "message"),
      once(socket, "close").then(() => {
        throw new Error("Attachment disconnected");
      }),
    ]);
    socket.send(
      JSON.stringify({ type: "attach", version: 1, execution: config.execution, identity, ticket }),
    );
    return { socket, response: JSON.parse(String((await response)[0])) };
  };
  return { config, grant, connect };
}
it("consumes tickets once and binds them to the exact terminal identity", async () => {
  const f = await fixture();
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  expect(Date.parse(ticket.deadline) - Date.now()).toBeLessThanOrEqual(60000);
  expect((await f.connect(ticket.ticket)).response.type).toBe("attached");
  expect((await f.connect(ticket.ticket)).response.type).toBe("failure");
  expect(fake.attaches).toBe(1);
});
it("applies resize before subsequent input and acknowledges Host acceptance", async () => {
  const f = await fixture();
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  const { socket } = await f.connect(ticket.ticket);
  const responses: object[] = [];
  socket.on("message", (data) => responses.push(JSON.parse(String(data))));
  socket.send(JSON.stringify({ type: "resize", seq: 1, cols: 100, rows: 30 }));
  socket.send(JSON.stringify({ type: "input", seq: 2, data: "🎹" }));
  await vi.waitFor(() => expect(responses).toHaveLength(2));
  expect(fake.operations).toEqual(["resize:100:30", "input:🎹"]);
  expect(responses[1]).toEqual({ type: "accepted", seq: 2, bytes: 4 });
});
it("revokes old controller input and blocks all grants after Stop", async () => {
  const f = await fixture();
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  const first = await f.connect(ticket.ticket);
  const next = await f.grant();
  if (next.type !== "ticket") throw new Error("Missing ticket");
  await f.connect(next.ticket);
  const rejected = once(first.socket, "message");
  first.socket.send(JSON.stringify({ type: "input", seq: 1, data: "stale" }));
  expect(JSON.parse(String((await rejected)[0])).type).toBe("failure");
  expect(fake.writes).toEqual([]);
  expect(
    await requestGateway(f.config.controlSocket, {
      type: "revoke",
      execution: f.config.execution,
      identity: f.config.identity,
    }),
  ).toEqual({ type: "revoked" });
  expect(await f.grant()).toEqual({ type: "error" });
});

it("disconnects overflowing queued input without accepting stale operations", async () => {
  const f = await fixture();
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  const { socket } = await f.connect(ticket.ticket);
  let release = () => {};
  let entered = false;
  fake.beforeWrite = () => {
    entered = true;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const failure = once(socket, "message");
  socket.send(JSON.stringify({ type: "input", seq: 1, data: "first" }));
  await vi.waitFor(() => expect(entered).toBe(true));
  for (let seq = 2; seq < 40; seq++)
    socket.send(JSON.stringify({ type: "input", seq, data: "x".repeat(32768) }));
  try {
    expect(JSON.parse(String((await failure)[0]))).toMatchObject({
      type: "failure",
      code: "overflow",
    });
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
  } finally {
    release();
  }
  expect(fake.writes).toEqual([]);
});

it("does not confirm Stop until in-flight Host acceptance and detachment settle", async () => {
  const f = await fixture();
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  const { socket } = await f.connect(ticket.ticket);
  let release = () => {};
  let entered = false;
  fake.beforeWrite = () => {
    entered = true;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  socket.send(JSON.stringify({ type: "input", seq: 1, data: "before-stop" }));
  await vi.waitFor(() => expect(entered).toBe(true));
  let confirmed = false;
  const stopped = requestGateway(f.config.controlSocket, {
    type: "revoke",
    execution: f.config.execution,
    identity: f.config.identity,
  }).then((response) => {
    confirmed = true;
    return response;
  });
  try {
    await vi.waitFor(async () => expect(await f.grant()).toEqual({ type: "error" }));
    expect(confirmed).toBe(false);
  } finally {
    release();
  }
  expect(await stopped).toEqual({ type: "revoked" });
});

it("rejects tickets from another gateway lifetime", async () => {
  const first = await fixture();
  const ticket = await first.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  const restarted = await fixture();
  expect((await restarted.connect(ticket.ticket)).response.type).toBe("failure");
  expect(fake.attaches).toBe(0);
});

it("disconnects oversized replay while retaining the agent for another attachment", async () => {
  const f = await fixture();
  fake.replay = "x".repeat(1024 * 1024);
  const ticket = await f.grant();
  if (ticket.type !== "ticket") throw new Error("Missing ticket");
  await expect(f.connect(ticket.ticket)).rejects.toThrow("Attachment disconnected");
  fake.replay = "history";
  const next = await f.grant();
  if (next.type !== "ticket") throw new Error("Missing ticket");
  expect((await f.connect(next.ticket)).response.ack.pid).toBe(42);
});
