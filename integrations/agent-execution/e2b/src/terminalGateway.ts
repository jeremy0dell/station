import { randomUUID } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import {
  createStationHostClient,
  type HostAttachment,
  isSameHostPtyIdentity,
  isSameHostPtyRef,
} from "@station/host";
import { WebSocket, WebSocketServer } from "ws";
import { privateDirectory } from "./state.js";
import {
  type GatewayConfig,
  GatewayConfigSchema,
  type GatewayRequest,
  GatewayRequestSchema,
  type GatewayResponse,
  GatewayResponseSchema,
  MAX_PENDING_BYTES,
  TerminalClientFrameSchema,
  type TerminalServerFrame,
} from "./terminalProtocol.js";

/**
 * ADAPTER
 *
 * Exposes only attachment to one recorded remote Host terminal. Tickets expire after 60 seconds
 * and are consumed before attachment. Revocation blocks grants before awaiting Host detach.
 */
export async function createTerminalGateway(config: GatewayConfig) {
  const tickets = new Map<string, number>();
  const clients = new Set<{
    socket: WebSocket;
    attachment?: HostAttachment;
    close(): Promise<void>;
  }>();
  let revoked = false;
  const identityMatches = (identity: GatewayConfig["identity"]) =>
    isSameHostPtyIdentity(identity, config.identity) && isSameHostPtyRef(identity, config.identity);
  const websocket = new WebSocketServer({
    port: config.port,
    host: "0.0.0.0",
    maxPayload: MAX_PENDING_BYTES,
    perMessageDeflate: false,
  });
  websocket.on("connection", (socket) => {
    if (revoked || clients.size >= 64) {
      socket.close(1013);
      return;
    }
    const host = createStationHostClient({ socketPath: config.hostSocket });
    let pending = Promise.resolve();
    let pendingBytes = 0;
    let sequence = 0;
    let acceptedBytes = 0;
    let closed = false;
    let attaching = false;
    const timeout = setTimeout(() => socket.terminate(), 15000);
    const send = (frame: TerminalServerFrame): Promise<void> =>
      new Promise((resolve, reject) => {
        const data = JSON.stringify(frame);
        if (
          socket.readyState !== WebSocket.OPEN ||
          socket.bufferedAmount + Buffer.byteLength(data) > MAX_PENDING_BYTES
        ) {
          socket.terminate();
          reject(new Error("Terminal output unavailable or overflowing."));
          return;
        }
        socket.send(data, (error) => (error ? reject(error) : resolve()));
      });
    const client: { socket: WebSocket; attachment?: HostAttachment; close(): Promise<void> } = {
      socket,
      async close() {
        closed = true;
        await pending;
        if (client.attachment !== undefined) await client.attachment.detach();
        socket.terminate();
      },
    };
    clients.add(client);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(timeout);
      closed = true;
      clients.delete(client);
      void client.attachment?.detach().catch(() => {});
      host.dispose();
    });
    const fail = async (code: "invalid" | "unavailable" | "revoked" | "overflow") => {
      closed = true;
      await send({
        type: "failure",
        code,
        message: `Cloud terminal ${code}; the agent was retained.`,
      }).catch(() => {});
      socket.close();
      setTimeout(() => socket.terminate(), 1000).unref();
    };
    socket.on("message", (data, binary) => {
      if (closed) return;
      const bytes = Buffer.byteLength(data.toString());
      pendingBytes += bytes;
      if (pendingBytes > MAX_PENDING_BYTES) {
        void fail("overflow");
        return;
      }
      pending = pending
        .then(async () => {
          if (closed || revoked) throw new Error("Revoked");
          if (binary) throw new Error("Binary frame");
          const frame = TerminalClientFrameSchema.parse(JSON.parse(data.toString()));
          if (frame.type === "attach") {
            if (
              attaching ||
              client.attachment !== undefined ||
              frame.execution !== config.execution ||
              !identityMatches(frame.identity)
            )
              throw new Error("Identity mismatch");
            const deadline = tickets.get(frame.ticket);
            tickets.delete(frame.ticket);
            if (deadline === undefined || deadline <= Date.now()) throw new Error("Ticket expired");
            attaching = true;
            const attachment = await host.attach(config.identity, "controller");
            client.attachment = attachment;
            if (closed || revoked) {
              await attachment.detach();
              throw new Error("Revoked");
            }
            clearTimeout(timeout);
            await send({ type: "attached", version: 1, ack: attachment.ack });
            void (async () => {
              for await (const output of attachment.frames) {
                if (closed || revoked) break;
                if (output.type === "control-revoked") {
                  await fail("revoked");
                  return;
                }
                await send({ type: "frame", frame: output });
                if (output.type === "exit") {
                  socket.close();
                  return;
                }
              }
              if (!closed) await fail("unavailable");
            })().catch(() => fail("unavailable"));
          } else {
            const attachment = client.attachment;
            if (attachment === undefined || frame.seq !== sequence + 1)
              throw new Error("Out of order");
            if (frame.type === "input") {
              await attachment.write(frame.data);
              acceptedBytes += Buffer.byteLength(frame.data);
            } else await attachment.resize(frame.cols, frame.rows);
            sequence = frame.seq;
            await send({ type: "accepted", seq: sequence, bytes: acceptedBytes });
          }
        })
        .catch(() => fail(revoked ? "revoked" : "unavailable"))
        .finally(() => {
          pendingBytes -= bytes;
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    websocket.once("listening", resolve);
    websocket.once("error", reject);
  });
  await privateDirectory(dirname(config.controlSocket));
  const control = createServer((socket) => {
    let buffer = "";
    let received = false;
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", async (chunk: Buffer) => {
      if (received) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > 16384) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      received = true;
      try {
        const request = GatewayRequestSchema.parse(JSON.parse(buffer.trim()));
        if (request.execution !== config.execution || !identityMatches(request.identity))
          throw new Error("Identity mismatch");
        let response: GatewayResponse;
        if (request.type === "revoke") {
          revoked = true;
          tickets.clear();
          // Only successful detach of every in-flight/current attachment confirms revocation.
          await Promise.all([...clients].map((client) => client.close()));
          response = { type: "revoked" };
        } else {
          if (revoked) throw new Error("Revoked");
          for (const [ticket, deadline] of tickets)
            if (deadline <= Date.now()) tickets.delete(ticket);
          if (tickets.size >= 64) throw new Error("Ticket capacity");
          const ticket = randomUUID();
          const deadline = Date.now() + 60000;
          tickets.set(ticket, deadline);
          response = { type: "ticket", ticket, deadline: new Date(deadline).toISOString() };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      } catch {
        socket.end('{"type":"error"}\n');
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(config.controlSocket, resolve);
    });
    await chmod(config.controlSocket, 0o600);
  } catch (error) {
    websocket.close();
    throw error;
  }
  return {
    async dispose() {
      revoked = true;
      tickets.clear();
      await Promise.allSettled([...clients].map((client) => client.close()));
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await rm(config.controlSocket, { force: true });
    },
  };
}

export async function readGatewayConfig(path: string): Promise<GatewayConfig> {
  return GatewayConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function requestGateway(path: string, request: GatewayRequest): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.setTimeout(15000, () => socket.destroy(new Error("Gateway timed out.")));
    socket.on("error", () => reject(new Error("Gateway control unavailable.")));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify(GatewayRequestSchema.parse(request))}\n`),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 16384) {
        socket.destroy();
        reject(new Error("Gateway response overflow."));
      }
    });
    socket.on("end", () => {
      try {
        resolve(GatewayResponseSchema.parse(JSON.parse(buffer.trim())));
      } catch {
        reject(new Error("Invalid gateway response."));
      }
      socket.destroy();
    });
  });
}
