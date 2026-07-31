import { once } from "node:events";
import { chmodSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { probeUnixSocket } from "@station/protocol";
import {
  errorCode,
  privatePathStat,
  releaseDatabase,
  type SqliteDatabase,
  type StationTtyClaimPaths,
  type StationTtyIdentity,
} from "./claim.js";

const REQUEST_TIMEOUT_MS = 500;
export const OWNER_VERSION = 1;
// The per-TTY path supplies identity; the literal distinguishes takeover from liveness probes.
const TAKEOVER_REQUEST = "takeover\n";
const TAKEOVER_ACCEPTED = "accepted\n";
const TAKEOVER_REFUSED = "refused\n";
const MAX_FRAME_BYTES = Buffer.byteLength(TAKEOVER_REQUEST);

/**
 * Holds the SQLite transaction and takeover endpoint for one stdin device.
 * HMR reuses both; release closes the endpoint before rolling back the claim,
 * after the renderer has already released raw stdin.
 */
export type StationTtyOwnership = {
  identity: StationTtyIdentity;
  setTakeoverHandler(handler?: () => void): void;
  release(): void;
};

type OwnedState = StationTtyOwnership & { version: number };
export type StationTtyOwnershipSlots = typeof globalThis & {
  __stationTtyOwnership?: OwnedState;
};
export type Takeover = "accepted" | "refused" | "unavailable";

export async function createOwner(
  identity: StationTtyIdentity,
  paths: StationTtyClaimPaths,
  database: SqliteDatabase,
  uid: number,
  slots: StationTtyOwnershipSlots,
): Promise<OwnedState> {
  await removeStaleSocket(paths.socket, uid);
  const sockets = new Set<Socket>();
  let takeoverHandler: (() => void) | undefined;
  let accepted = false;
  let released = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void readFrame(socket, true).then((request) => {
      if (request !== TAKEOVER_REQUEST || released) return socket.destroy();
      if (accepted || takeoverHandler === undefined) return socket.end(TAKEOVER_REFUSED);
      accepted = true;
      const acceptedHandler = takeoverHandler;
      socket.end(TAKEOVER_ACCEPTED, () => acceptedHandler?.());
    });
  });
  let socketStat: Stats;
  try {
    await once(server.listen(paths.socket), "listening");
    chmodSync(paths.socket, 0o600);
    socketStat = privatePathStat(paths.socket, uid, "socket", 0o600);
  } catch (error) {
    server.close();
    throw error;
  }

  const ownership: OwnedState = {
    version: OWNER_VERSION,
    identity,
    setTakeoverHandler: (handler) => {
      if (!released) takeoverHandler = handler;
    },
    release: () => {
      if (released) return;
      released = true;
      takeoverHandler = undefined;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      try {
        const socket = lstatSync(paths.socket);
        if (socket.isSocket() && socket.dev === socketStat.dev && socket.ino === socketStat.ino) {
          unlinkSync(paths.socket);
        }
      } catch {
        // The claim still releases; a successor validates the endpoint before removal.
      }
      if (slots.__stationTtyOwnership === ownership) slots.__stationTtyOwnership = undefined;
      releaseDatabase(database);
    },
  };
  return ownership;
}

export async function requestTakeover(path: string): Promise<Takeover> {
  const socket = createConnection(path);
  socket.once("connect", () => socket.write(TAKEOVER_REQUEST));
  const response = await readFrame(socket);
  socket.destroy();
  if (response === TAKEOVER_ACCEPTED) return "accepted";
  if (response === TAKEOVER_REFUSED) return "refused";
  return "unavailable";
}

function readFrame(socket: Socket, settleOnNewline = false): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let newlineScheduled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(value);
    };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      finish();
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES) {
        socket.destroy();
        return finish();
      }
      if (settleOnNewline && !newlineScheduled && buffer.includes(0x0a)) {
        newlineScheduled = true;
        setTimeout(() => finish(parseFrame(buffer)), 0);
      }
    });
    socket.once("end", () => finish(parseFrame(buffer)));
    socket.once("error", () => finish());
  });
}

function parseFrame(buffer: Buffer): string | undefined {
  const text = buffer.toString("utf8");
  return text.indexOf("\n") === text.length - 1 ? text : undefined;
}

async function removeStaleSocket(path: string, uid: number): Promise<void> {
  let before: Stats;
  try {
    before = privatePathStat(path, uid, "socket", 0o600);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const probe = await probeUnixSocket(path, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (probe.status === "absent") return;
  if (probe.status !== "stale") throw new Error("Station TTY endpoint may be live.");
  const after = lstatSync(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("Station TTY endpoint changed during validation.");
  }
  unlinkSync(path);
}
