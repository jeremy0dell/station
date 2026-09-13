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
              events: [{ type: "data", data: "history" }],
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
    const response = once(socket, "message");
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
