import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { privateDirectory } from "./state.js";
import {
  BrokerRequestSchema,
  BrokerResponseSchema,
  type TerminalGrant,
} from "./terminalProtocol.js";

/**
 * ADAPTER
 *
 * Grants attachment credentials over a private local socket. Established terminal traffic
 * bypasses this broker and survives its disposal; Stop explicitly signals registered relays.
 */
export async function createTerminalBroker(
  directory: string,
  grant: (id: string) => Promise<TerminalGrant | undefined>,
) {
  await privateDirectory(directory);
  const path = join(directory, "terminal.sock");
  const previous = await lstat(path).catch((error) => {
    if (
      z
        .object({ code: z.literal("ENOENT") })
        .passthrough()
        .safeParse(error).success
    )
      return undefined;
    throw error;
  });
  if (previous !== undefined) {
    if (!previous.isSocket() || previous.uid !== process.getuid?.())
      throw new Error("Unowned broker socket.");
    const stale = await new Promise<boolean>((resolve) => {
      const probe = createConnection(path);
      probe.setTimeout(1000, () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", (error) =>
        resolve(
          z
            .object({ code: z.literal("ECONNREFUSED") })
            .passthrough()
            .safeParse(error).success,
        ),
      );
    });
    const current = await lstat(path);
    if (!stale || current.ino !== previous.ino || current.dev !== previous.dev)
      throw new Error("A live or replaced terminal broker owns this socket.");
    await rm(path);
  }
  let disposed = false;
  const sockets = new Map<Socket, string>();
  const revoked = new Set<string>();
  const server = createServer((socket) => {
    let buffer = "";
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", async (chunk: Buffer) => {
      if (sockets.has(socket)) {
        socket.destroy();
        return;
      }
      buffer += chunk.toString("utf8");
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      socket.pause();
      try {
        const request = BrokerRequestSchema.parse(JSON.parse(buffer.trim()));
        sockets.set(socket, request.sessionId);
        if (revoked.has(request.sessionId)) throw new Error("Stopped");
        const result = await grant(request.sessionId);
        if (revoked.has(request.sessionId) || socket.destroyed) throw new Error("Stopped");
        socket.setTimeout(0);
        socket.write(
          `${JSON.stringify(result === undefined ? { type: "legacy" } : { type: "grant", grant: result })}\n`,
        );
      } catch {
        socket.end('{"type":"unavailable"}\n');
      }
    });
  });
  // A live broker must never be replaced by another Observer.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    path,
    revoke(id: string) {
      revoked.add(id);
      for (const [socket, session] of sockets)
        if (session === id) socket.end('{"type":"revoked"}\n');
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const socket of sockets.keys()) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(path, { force: true });
    },
  };
}

/** Opens a grant connection whose later revocation notification stops the relay. */
export function requestTerminalGrant(path: string, sessionId: string, onRevoke: () => void) {
  return new Promise<{ response: z.infer<typeof BrokerResponseSchema>; close(): void }>(
    (resolve, reject) => {
      const socket = createConnection(path);
      let buffer = "";
      let resolved = false;
      socket.setTimeout(15000, () => socket.destroy(new Error("Attachment broker timed out.")));
      socket.on("error", () => {
        if (!resolved) reject(new Error("Attachment broker unavailable."));
      });
      socket.on("close", () => {
        if (!resolved) reject(new Error("Attachment broker disconnected."));
      });
      socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, sessionId })}\n`));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 16384) {
          socket.destroy();
          return;
        }
        try {
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n");
            const response = BrokerResponseSchema.parse(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
            if (response.type === "revoked") onRevoke();
            if (!resolved) {
              resolved = true;
              socket.setTimeout(0);
              resolve({ response, close: () => socket.destroy() });
            }
          }
        } catch {
          socket.destroy();
        }
      });
    },
  );
}
