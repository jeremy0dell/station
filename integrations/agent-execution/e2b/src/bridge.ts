import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { privateDirectory } from "./state.js";

const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
const FrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("attach"),
      sessionId: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/),
      ...size,
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      data: z
        .string()
        .max(48_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .strict(),
  z.object({ type: z.literal("resize"), ...size }).strict(),
]);
const OutputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("output"),
      data: z
        .string()
        .max(48_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .strict(),
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("error"), message: z.string().max(500) }).strict(),
]);
export type RemoteAttachment = {
  input(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  detach(): Promise<void>;
};
type Attach = (
  sessionId: string,
  cols: number,
  rows: number,
  output: (data: Uint8Array) => void,
) => Promise<RemoteAttachment>;

function send(
  socket: Socket,
  value: z.infer<typeof OutputSchema> | z.infer<typeof FrameSchema>,
): void {
  if (socket.destroyed) return;
  if (socket.writableLength > 1024 * 1024) {
    socket.destroy();
    return;
  }
  socket.write(`${JSON.stringify(value)}\n`);
}

/**
 * ADAPTER
 *
 * Serves bounded terminal attachments on a private local socket. It carries no cloud credentials;
 * replacing an attachment or stopping the Observer revokes input before remote detach completes.
 */
export async function createExecutionBridge(directory: string, attach: Attach) {
  await privateDirectory(directory);
  const path = join(directory, `${randomUUID().slice(0, 8)}.sock`);
  const sockets = new Set<Socket>();
  const controllers = new Map<string, Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let remote: RemoteAttachment | undefined;
    let sessionId: string | undefined;
    let closed = false;
    let pending = Promise.resolve();
    socket.setTimeout(15_000, () => {
      if (remote === undefined) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      closed = true;
      sockets.delete(socket);
      if (sessionId !== undefined && controllers.get(sessionId) === socket)
        controllers.delete(sessionId);
      void remote?.detach().catch(() => {});
    });
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      buffer += chunk.toString("utf8");
      if (buffer.length > 65_536) {
        socket.destroy();
        return;
      }
      pending = pending
        .then(async () => {
          while (!closed && !socket.destroyed && buffer.includes("\n")) {
            const end = buffer.indexOf("\n");
            const frame = FrameSchema.parse(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
            if (frame.type === "attach") {
              if (sessionId !== undefined) throw new Error("Already attached");
              sessionId = frame.sessionId;
              controllers.get(sessionId)?.destroy();
              controllers.set(sessionId, socket);
              const acquired = await attach(sessionId, frame.cols, frame.rows, (data) => {
                for (let start = 0; start < data.length; start += 32_768) {
                  send(socket, {
                    type: "output",
                    data: Buffer.from(data.subarray(start, start + 32_768)).toString("base64"),
                  });
                }
              });
              if (closed || socket.destroyed || controllers.get(sessionId) !== socket) {
                await acquired.detach();
                return;
              }
              remote = acquired;
              socket.setTimeout(0);
              send(socket, { type: "ready" });
            } else {
              if (
                remote === undefined ||
                sessionId === undefined ||
                controllers.get(sessionId) !== socket
              )
                throw new Error("Attachment unavailable");
              if (frame.type === "input") await remote.input(Buffer.from(frame.data, "base64"));
              else await remote.resize(frame.cols, frame.rows);
            }
          }
          if (!closed) socket.resume();
        })
        .catch(() => {
          send(socket, {
            type: "error",
            message:
              "Cloud terminal disconnected. Reopen this session to reconnect; no new agent was started.",
          });
          socket.end();
          socket.destroySoon();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    path,
    revoke(sessionId: string) {
      const socket = controllers.get(sessionId);
      controllers.delete(sessionId);
      socket?.destroy();
    },
    async dispose() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(path, { force: true });
    },
  };
}

/** Connects ordinary terminal input/output to the Observer-owned execution attachment. */
export async function runExecutionBridge(path: string, sessionId: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("Cloud attachment requires an interactive terminal.");
  const socket = createConnection(path);
  let buffer = "";
  const raw = process.stdin.isRaw;
  const dimensions = () => ({
    cols: Math.min(1000, process.stdout.columns || 80),
    rows: Math.min(1000, process.stdout.rows || 24),
  });
  const input = (data: Buffer) => {
    for (let offset = 0; offset < data.length; offset += 32_768)
      send(socket, {
        type: "input",
        data: data.subarray(offset, offset + 32_768).toString("base64"),
      });
  };
  const resize = () => send(socket, { type: "resize", ...dimensions() });
  const stop = () => socket.end();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", resolve);
      socket.once("connect", () => send(socket, { type: "attach", sessionId, ...dimensions() }));
      socket.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        if (buffer.length > 1024 * 1024) {
          socket.destroy(new Error("Cloud output exceeded the terminal buffer limit."));
          return;
        }
        try {
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n");
            const frame = OutputSchema.parse(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
            if (frame.type === "ready") {
              process.stdin.setRawMode(true);
              process.stdin.on("data", input);
              process.stdout.on("resize", resize);
              process.on("SIGTERM", stop);
              process.on("SIGHUP", stop);
              process.stdin.resume();
            } else if (frame.type === "output") {
              if (!process.stdout.write(Buffer.from(frame.data, "base64"))) {
                socket.pause();
                process.stdout.once("drain", () => socket.resume());
              }
            } else socket.destroy(new Error(frame.message));
          }
        } catch {
          socket.destroy(new Error("Invalid cloud terminal response."));
        }
      });
    });
  } finally {
    socket.destroy();
    process.stdin.off("data", input);
    process.stdout.off("resize", resize);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    process.stdin.setRawMode(raw);
    process.stdin.pause();
  }
}
