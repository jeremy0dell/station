import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import type { SafeError } from "@station/contracts";
import { isSafeError, runRuntimeBoundary, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { z } from "zod";
import { protocolSafeError } from "./messages.js";
import { unwrapBoundaryResult } from "./runtime.js";

const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 1000;
const MIN_SOCKET_PROBE_TIMEOUT_MS = 1;
const PositivePidSchema = z.coerce.number().int().positive();
const ErrorCodeSchema = z.object({ code: z.string() });

export type NdjsonConnection = {
  send(value: unknown): void;
  messages(): AsyncIterable<unknown>;
  close(): void;
  readonly closed: Promise<void>;
};

export type ListenUnixSocketOptions = {
  socketPath: string;
  onConnection(connection: NdjsonConnection): void | Promise<void>;
};

export type UnixSocketServer = {
  readonly socketPath: string;
  close(): Promise<void>;
  abandon(): void;
};

export type ConnectUnixSocketOptions = {
  timeoutMs?: number;
};

export type SocketIdentity = { ino: bigint; birthtimeNs: bigint };

export type UnixSocketProbe =
  | { status: "absent" }
  | { status: "listening"; identity: SocketIdentity }
  | { status: "stale"; identity: SocketIdentity }
  | {
      status: "inaccessible";
      identity?: SocketIdentity;
      reason:
        | "permission-denied"
        | "timeout"
        | "live-holder"
        | "evidence-unavailable"
        | "path-changed"
        | "not-a-socket"
        | "unclassified";
      error: SafeError;
    };

export type UnixSocketPathMetadata = SocketIdentity & { isSocket: boolean };

export type UnixSocketProbeOptions = {
  timeoutMs?: number;
  socketHolders?: (socketPath: string) => readonly number[] | Promise<readonly number[]>;
  connect?: (socketPath: string, timeoutMs: number) => Promise<void>;
  readMetadata?: (socketPath: string) => Promise<UnixSocketPathMetadata | undefined>;
};

type UnixSocketHolderReaderOptions = {
  runLsof?: (
    file: string,
    args: readonly string[],
  ) => Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">;
};

/** ADAPTER: Returns the canonical executable used for Unix-socket holder evidence. */
export function unixSocketHolderEvidencePath(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
}

export async function ensureSocketDirectory(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
}

/**
 * ADAPTER
 *
 * Translates filesystem, connection, and process-holder evidence into four
 * fail-closed Unix-socket ownership states.
 */
export async function probeUnixSocket(
  socketPath: string,
  options: UnixSocketProbeOptions = {},
): Promise<UnixSocketProbe> {
  const readMetadata = options.readMetadata ?? readUnixSocketMetadata;
  let initial: UnixSocketPathMetadata | undefined;
  try {
    initial = await readMetadata(socketPath);
  } catch (error) {
    return inaccessibleSocket("unclassified", error);
  }
  if (initial === undefined) return { status: "absent" };
  if (!initial.isSocket) {
    return inaccessibleSocket("not-a-socket", undefined, socketIdentity(initial));
  }

  const initialIdentity = socketIdentity(initial);
  const timeoutMs = Math.max(
    MIN_SOCKET_PROBE_TIMEOUT_MS,
    options.timeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
  );
  const connect = options.connect ?? probeUnixSocketConnection;

  try {
    await connect(socketPath, timeoutMs);
    const current = await readMetadataAfterProbe(readMetadata, socketPath, initialIdentity);
    if (current.status === "inaccessible") return current;
    return { status: "listening", identity: initialIdentity };
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return inaccessibleSocket("permission-denied", error, initialIdentity);
    }
    if (code === "PROTOCOL_CONNECT_TIMEOUT") {
      return inaccessibleSocket("timeout", error, initialIdentity);
    }

    let current: UnixSocketPathMetadata | undefined;
    try {
      current = await readMetadata(socketPath);
    } catch (metadataError) {
      return inaccessibleSocket("unclassified", metadataError, initialIdentity);
    }
    if (current === undefined) return { status: "absent" };
    if (!current.isSocket) {
      return inaccessibleSocket("not-a-socket", error, socketIdentity(current));
    }
    if (!socketIdentitiesMatch(initialIdentity, current)) {
      return inaccessibleSocket("path-changed", error, socketIdentity(current));
    }

    // Bun reports ENOENT for both a live inaccessible pathname and a dead socket.
    if (code !== "ECONNREFUSED" && code !== "ENOENT") {
      return inaccessibleSocket("unclassified", error, initialIdentity);
    }
    try {
      const holders = await (options.socketHolders ?? readUnixSocketHolderPids)(socketPath);
      return holders.length === 0
        ? { status: "stale", identity: initialIdentity }
        : inaccessibleSocket("live-holder", error, initialIdentity);
    } catch (evidenceError) {
      return inaccessibleSocket("evidence-unavailable", evidenceError, initialIdentity);
    }
  }
}

/**
 * ADAPTER
 *
 * Reads canonical lsof holder evidence, treating only its empty status-1 result
 * as proof that no process owns the socket.
 */
export function readUnixSocketHolderPids(
  socketPath: string,
  options: UnixSocketHolderReaderOptions = {},
): number[] {
  const result = (options.runLsof ?? runLsof)(unixSocketHolderEvidencePath(), ["-t", socketPath]);
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (
    result.error !== undefined ||
    result.signal !== null ||
    stderr.length > 0 ||
    (result.status !== 0 && result.status !== 1)
  ) {
    throw socketEvidenceUnavailable(socketPath);
  }
  // lsof uses status 1 with no output for its canonical no-match result.
  if (result.status === 1) {
    if (stdout.length === 0) return [];
    throw socketEvidenceUnavailable(socketPath);
  }

  const lines = stdout.trimEnd().split("\n");
  if (lines.length === 0 || lines.every((line) => line.length === 0)) {
    throw socketEvidenceUnavailable(socketPath);
  }
  const pids: number[] = [];
  for (const line of lines) {
    const pid = PositivePidSchema.safeParse(line);
    if (!pid.success) throw socketEvidenceUnavailable(socketPath);
    pids.push(pid.data);
  }
  return [...new Set(pids)];
}

/**
 * ADAPTER
 *
 * Binds before reclaiming, revalidates stale-path identity immediately before
 * unlink, and exposes normal owned close separately from displaced abandon.
 */
export async function listenUnixSocket(
  options: ListenUnixSocketOptions,
): Promise<UnixSocketServer> {
  await ensureSocketDirectory(options.socketPath);

  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    const connection = ndjsonConnection(socket);
    void options.onConnection(connection);
  });

  await bindWithStaleReclaim(server, options.socketPath);

  try {
    await chmod(options.socketPath, 0o600);
  } catch {
    // Some platforms do not allow chmod on socket files; the parent dir is still 0700.
  }

  return {
    socketPath: options.socketPath,
    close: () => closeServer(server, options.socketPath, sockets),
    abandon: () => abandonServer(server, sockets),
  };
}

async function bindWithStaleReclaim(server: Server, socketPath: string): Promise<void> {
  try {
    await listenOnce(server, socketPath);
    return;
  } catch (error) {
    if (errorCode(error) !== "EADDRINUSE") {
      throw error;
    }
    const probe = await probeUnixSocket(socketPath);
    if (probe.status === "inaccessible") throw probe.error;
    if (probe.status !== "stale") {
      throw error;
    }
    const current = await readUnixSocketMetadata(socketPath);
    // The stale evidence authorizes removal only while the exact probed pathname survives.
    if (current === undefined || !socketIdentitiesMatch(probe.identity, current)) {
      throw inaccessibleSocket("path-changed", undefined, current).error;
    }
    await unlink(socketPath);
    await listenOnce(server, socketPath);
  }
}

function listenOnce(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export function connectUnixSocket(
  socketPath: string,
  options: ConnectUnixSocketOptions = {},
): Promise<NdjsonConnection> {
  const task = ({ signal }: { signal: AbortSignal }) => connectUnixSocketOnce(socketPath, signal);
  const baseOptions = {
    operation: "protocol.socket.connect",
    error: protocolSafeError({
      code: "PROTOCOL_CONNECT_FAILED",
      message: `Could not connect to observer socket ${socketPath}.`,
    }),
  };
  if (options.timeoutMs === undefined) {
    return runRuntimeBoundary(baseOptions, task).then(unwrapBoundaryResult);
  }

  return runRuntimeBoundaryWithTimeout(
    {
      ...baseOptions,
      timeoutMs: options.timeoutMs,
      timeoutError: protocolSafeError({
        tag: "TimeoutError",
        code: "PROTOCOL_CONNECT_TIMEOUT",
        message: `Timed out connecting to observer socket ${socketPath}.`,
      }),
    },
    task,
  ).then(unwrapBoundaryResult);
}

function connectUnixSocketOnce(socketPath: string, signal: AbortSignal): Promise<NdjsonConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      socket.destroy();
      settle(() =>
        reject(
          protocolSafeError({
            tag: "TimeoutError",
            code: "PROTOCOL_CONNECT_TIMEOUT",
            message: `Timed out connecting to observer socket ${socketPath}.`,
          }),
        ),
      );
    };
    const onConnect = () => {
      settle(() => resolve(ndjsonConnection(socket)));
    };
    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function ndjsonConnection(socket: Socket): NdjsonConnection {
  socket.setEncoding("utf8");
  let buffer = "";
  let closedResolve: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const messages: unknown[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  let streamError: Error | undefined;

  // Socket data is push-based, while callers consume a pull-based AsyncIterable.
  // Parsed frames queue in messages; waiters wake consumers blocked on next().
  const wake = () => {
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(line));
      } catch (error) {
        // A malformed frame poisons the stream so the generator surfaces the parse error.
        streamError = error instanceof Error ? error : new Error("Invalid NDJSON frame.");
        socket.destroy(streamError);
      }
    }
    wake();
  });

  socket.on("error", (error) => {
    streamError = error;
    done = true;
    wake();
    closedResolve();
  });
  socket.on("close", () => {
    done = true;
    wake();
    closedResolve();
  });

  return {
    send: (value) => {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    messages: async function* () {
      for (;;) {
        if (messages.length > 0) {
          yield messages.shift();
          continue;
        }
        if (streamError !== undefined) {
          throw streamError;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    close: () => {
      socket.end();
      socket.destroySoon();
    },
    closed,
  };
}

/**
 * Cross-wired in-memory NDJSON pair for socket-free tests; closing either end
 * completes the peer's messages and closed promise like a socket disconnect.
 */
export function inMemoryNdjsonConnectionPair(): {
  client: NdjsonConnection;
  server: NdjsonConnection;
} {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  return {
    client: inMemoryEndpoint(toClient, toServer),
    server: inMemoryEndpoint(toServer, toClient),
  };
}

function inMemoryEndpoint(incoming: PassThrough, outgoing: PassThrough): NdjsonConnection {
  incoming.setEncoding("utf8");
  let buffer = "";
  let done = false;
  let streamError: Error | undefined;
  const queue: unknown[] = [];
  const waiters: Array<() => void> = [];
  let closedResolve: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const wake = () => {
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  };
  const finish = () => {
    done = true;
    wake();
    closedResolve();
  };
  incoming.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      try {
        queue.push(JSON.parse(line));
      } catch (error) {
        streamError = error instanceof Error ? error : new Error("Invalid NDJSON frame.");
        incoming.destroy(streamError);
      }
    }
    wake();
  });
  incoming.on("end", finish);
  incoming.on("close", finish);
  incoming.on("error", (error) => {
    streamError = error;
    finish();
  });
  return {
    send: (value) => {
      outgoing.write(`${JSON.stringify(value)}\n`);
    },
    messages: async function* () {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (streamError !== undefined) {
          throw streamError;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    close: () => {
      // End the peer's stream AND complete our own (a real socket close() ends
      // both directions locally), so the closing endpoint's `closed`/`messages()`
      // resolve too — matching `ndjsonConnection`.
      outgoing.end();
      finish();
    },
    closed,
  };
}

async function closeServer(
  server: Server,
  _socketPath: string,
  sockets: Set<Socket>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  for (const socket of sockets) {
    socket.end();
    socket.destroySoon();
  }
  await closed;
}

function abandonServer(server: Server, sockets: Set<Socket>): void {
  for (const socket of sockets) {
    socket.destroy();
  }
  // A displaced server must leave the successor pathname intact; process exit releases its fd.
  server.unref();
}

async function probeUnixSocketConnection(socketPath: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const signal = AbortSignal.timeout(timeoutMs);
    let settled = false;
    const onAbort = () => {
      settle(() =>
        reject(
          protocolSafeError({
            tag: "TimeoutError",
            code: "PROTOCOL_CONNECT_TIMEOUT",
            message: `Timed out connecting to Unix socket ${socketPath}.`,
          }),
        ),
      );
      socket.destroy();
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onConnect = () => {
      settle(resolve);
      socket.end();
      socket.destroy();
    };
    const onError = (error: Error) => {
      settle(() => reject(error));
      socket.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function readMetadataAfterProbe(
  readMetadata: (socketPath: string) => Promise<UnixSocketPathMetadata | undefined>,
  socketPath: string,
  initialIdentity: SocketIdentity,
): Promise<{ status: "unchanged" } | Extract<UnixSocketProbe, { status: "inaccessible" }>> {
  try {
    const current = await readMetadata(socketPath);
    if (
      current === undefined ||
      !current.isSocket ||
      !socketIdentitiesMatch(initialIdentity, current)
    ) {
      return inaccessibleSocket(
        current !== undefined && !current.isSocket ? "not-a-socket" : "path-changed",
        undefined,
        current,
      );
    }
    return { status: "unchanged" };
  } catch (error) {
    return inaccessibleSocket("unclassified", error, initialIdentity);
  }
}

async function readUnixSocketMetadata(
  socketPath: string,
): Promise<UnixSocketPathMetadata | undefined> {
  try {
    const stats = await lstat(socketPath, { bigint: true });
    return {
      ino: stats.ino,
      birthtimeNs: stats.birthtimeNs,
      isSocket: stats.isSocket(),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function socketIdentity(metadata: SocketIdentity): SocketIdentity {
  return { ino: metadata.ino, birthtimeNs: metadata.birthtimeNs };
}

function socketIdentitiesMatch(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function inaccessibleSocket(
  reason: Extract<UnixSocketProbe, { status: "inaccessible" }>["reason"],
  error: unknown,
  identity?: SocketIdentity,
): Extract<UnixSocketProbe, { status: "inaccessible" }> {
  const fallback = protocolSafeError({
    code: "PROTOCOL_SOCKET_INACCESSIBLE",
    message: "The Unix socket exists but cannot be reached or proven safe to reclaim.",
  });
  const safeError = isSafeError(error) ? error : fallback;
  const result: Extract<UnixSocketProbe, { status: "inaccessible" }> = {
    status: "inaccessible",
    reason,
    error: safeError,
  };
  if (identity !== undefined) result.identity = socketIdentity(identity);
  return result;
}

function errorCode(error: unknown): string | undefined {
  const parsed = ErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function runLsof(file: string, args: readonly string[]) {
  return spawnSync(file, [...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function socketEvidenceUnavailable(socketPath: string): Error & SafeError {
  const safeError = protocolSafeError({
    code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE",
    message: `Could not determine process ownership for Unix socket ${socketPath}.`,
  });
  return Object.assign(new Error(safeError.message), safeError);
}
