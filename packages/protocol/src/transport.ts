import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import type { SafeError } from "@station/contracts";
import {
  isSafeError,
  runExternalCommand,
  runRuntimeBoundary,
  runRuntimeBoundaryWithTimeout,
} from "@station/runtime";
import { z } from "zod";
import { protocolSafeError } from "./messages.js";
import { unwrapBoundaryResult } from "./runtime.js";

const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 1000;
const MIN_SOCKET_PROBE_TIMEOUT_MS = 1;
export const NDJSON_TRANSPORT_LIMITS = Object.freeze({
  maxQueuedFrames: 1_024,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxFrameBytes: 16 * 1024 * 1024,
});
export type NdjsonTransportLimits = typeof NDJSON_TRANSPORT_LIMITS;
const CanonicalPositivePidSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const ErrorCodeSchema = z.object({ code: z.string() });

export type NdjsonTransportOverflowReason =
  | "queued-frames"
  | "queued-bytes"
  | "frame-bytes"
  | "partial-frame-bytes"
  | "outbound-backpressure"
  | "outbound-frame-bytes";

export type NdjsonTransportDiagnostics = {
  inboundQueueDepth: number;
  inboundQueueBytes: number;
  inboundHighWaterDepth: number;
  inboundHighWaterBytes: number;
  outboundBackpressureCount: number;
  overflowCount: number;
  closeCount: number;
  lastOverflowReason?: NdjsonTransportOverflowReason;
};

/** One bounded NDJSON connection with content-free queue and overload diagnostics. */
export type NdjsonConnection = {
  send(value: unknown): boolean;
  messages(): AsyncIterable<unknown>;
  close(): void;
  diagnostics(): NdjsonTransportDiagnostics;
  readonly closed: Promise<void>;
};

export type ListenUnixSocketOptions = {
  socketPath: string;
  onConnection(connection: NdjsonConnection): void | Promise<void>;
  /** Absent preserves the transport's legacy unbounded behavior for Station Host PTY traffic. */
  transportLimits?: NdjsonTransportLimits;
};

export type UnixSocketServer = {
  readonly socketPath: string;
  close(): Promise<void>;
  abandon(): void;
};

export type ConnectUnixSocketOptions = {
  timeoutMs?: number;
  /** Absent preserves the transport's legacy unbounded behavior for Station Host PTY traffic. */
  transportLimits?: NdjsonTransportLimits;
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
  /** Bounds the holder-evidence subprocess; defaults to the socket probe timeout. */
  timeoutMs?: number;
  runLsof?: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">;
};

type AsyncUnixSocketHolderReaderOptions = {
  deadlineMs: number;
  signal?: AbortSignal;
};

/** Returns the canonical executable used for Unix-socket holder evidence. */
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
 * fail-closed Unix-socket ownership states, revalidating path identity after
 * holder-evidence races before classifying the final state.
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
  const deadlineMs = Date.now() + timeoutMs;
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
      const holderTimeoutMs = Math.max(MIN_SOCKET_PROBE_TIMEOUT_MS, deadlineMs - Date.now());
      const holders = await (
        options.socketHolders ??
        ((path: string) => readUnixSocketHolderPids(path, { timeoutMs: holderTimeoutMs }))
      )(socketPath);
      return holders.length === 0
        ? { status: "stale", identity: initialIdentity }
        : inaccessibleSocket("live-holder", error, initialIdentity);
    } catch (evidenceError) {
      // Holder evidence can race normal endpoint removal; refresh the path fact before refusing.
      let final: UnixSocketPathMetadata | undefined;
      try {
        final = await readMetadata(socketPath);
      } catch (metadataError) {
        return inaccessibleSocket("unclassified", metadataError, initialIdentity);
      }
      if (final === undefined) return { status: "absent" };
      if (!final.isSocket) {
        return inaccessibleSocket("not-a-socket", evidenceError, socketIdentity(final));
      }
      if (!socketIdentitiesMatch(initialIdentity, final)) {
        return inaccessibleSocket("path-changed", evidenceError, socketIdentity(final));
      }
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
  const timeoutMs = Math.max(
    MIN_SOCKET_PROBE_TIMEOUT_MS,
    options.timeoutMs ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS,
  );
  const result = (options.runLsof ?? runLsof)(
    unixSocketHolderEvidencePath(),
    ["-t", socketPath],
    timeoutMs,
  );
  return parseUnixSocketHolderPids(socketPath, result);
}

/**
 * ADAPTER
 *
 * Reads canonical lsof evidence without blocking the deadline or caller-abort clock turn.
 */
export async function readUnixSocketHolderPidsAsync(
  socketPath: string,
  options: AsyncUnixSocketHolderReaderOptions,
): Promise<number[]> {
  const deadlineMs = options.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || options.signal?.aborted || deadlineMs <= Date.now())
    throw socketEvidenceUnavailable(socketPath);
  const result = await runExternalCommand({
    command: unixSocketHolderEvidencePath(),
    args: ["-t", socketPath],
    timeoutMs: Math.max(1, deadlineMs - Date.now()),
    allowedExitCodes: [1],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch(() => {
    throw socketEvidenceUnavailable(socketPath);
  });
  if (options.signal?.aborted === true || Date.now() >= deadlineMs)
    throw socketEvidenceUnavailable(socketPath);
  return parseUnixSocketHolderPids(socketPath, {
    status: result.exitCode,
    signal: null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function parseUnixSocketHolderPids(
  socketPath: string,
  result: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">,
): number[] {
  if (result.error !== undefined || result.signal !== null || result.stderr !== "")
    throw socketEvidenceUnavailable(socketPath);
  if (result.status === 1 && result.stdout === "") return [];
  if (result.status !== 0 || result.stdout === "" || result.stdout.includes("\r"))
    throw socketEvidenceUnavailable(socketPath);
  const body = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  const pids = z.array(CanonicalPositivePidSchema).safeParse(body.split("\n"));
  if (!pids.success) throw socketEvidenceUnavailable(socketPath);
  return [...new Set(pids.data)];
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
    const connection = ndjsonConnection(socket, options.transportLimits);
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
  const task = ({ signal }: { signal: AbortSignal }) =>
    connectUnixSocketOnce(socketPath, signal, options.transportLimits);
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

function connectUnixSocketOnce(
  socketPath: string,
  signal: AbortSignal,
  transportLimits: NdjsonTransportLimits | undefined,
): Promise<NdjsonConnection> {
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
      settle(() => resolve(ndjsonConnection(socket, transportLimits)));
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

function ndjsonConnection(
  socket: Socket,
  transportLimits: NdjsonTransportLimits | undefined,
): NdjsonConnection {
  socket.setEncoding("utf8");
  let closedResolve: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const state = createNdjsonState(
    {
      close: () => {
        socket.end();
        socket.destroySoon();
      },
      destroy: () => socket.destroy(),
      onFinish: closedResolve,
    },
    transportLimits,
  );
  let writeBlocked = false;
  const onDrain = () => {
    writeBlocked = false;
  };

  socket.on("data", state.ingest);
  socket.on("error", state.finish);
  socket.on("close", () => state.finish());

  return {
    send: (value) => {
      const frame = `${JSON.stringify(value)}\n`;
      if (!state.canSend()) return false;
      if (
        transportLimits !== undefined &&
        Buffer.byteLength(frame, "utf8") > transportLimits.maxFrameBytes
      ) {
        state.overflow("outbound-frame-bytes");
        return false;
      }
      if (writeBlocked && transportLimits !== undefined) {
        state.overflow("outbound-backpressure");
        return false;
      }
      if (!socket.write(frame)) {
        writeBlocked = true;
        state.recordOutboundBackpressure();
        socket.once("drain", onDrain);
      }
      return true;
    },
    messages: state.messages,
    close: state.close,
    diagnostics: state.diagnostics,
    closed,
  };
}

/**
 * Cross-wired in-memory NDJSON pair for socket-free tests; closing either end
 * completes the peer's messages and closed promise like a socket disconnect.
 */
export function inMemoryNdjsonConnectionPair(transportLimits?: NdjsonTransportLimits): {
  client: NdjsonConnection;
  server: NdjsonConnection;
} {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  return {
    client: inMemoryEndpoint(toClient, toServer, transportLimits),
    server: inMemoryEndpoint(toServer, toClient, transportLimits),
  };
}

function inMemoryEndpoint(
  incoming: PassThrough,
  outgoing: PassThrough,
  transportLimits: NdjsonTransportLimits | undefined,
): NdjsonConnection {
  incoming.setEncoding("utf8");
  let closedResolve: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  let state: ReturnType<typeof createNdjsonState>;
  state = createNdjsonState(
    {
      close: () => {
        outgoing.end();
        state.finish();
      },
      destroy: () => {
        outgoing.destroy();
        incoming.destroy();
      },
      onFinish: closedResolve,
    },
    transportLimits,
  );
  let writeBlocked = false;
  outgoing.on("drain", () => {
    writeBlocked = false;
  });
  incoming.on("data", state.ingest);
  incoming.on("end", () => state.finish());
  incoming.on("close", () => state.finish());
  incoming.on("error", state.finish);
  return {
    send: (value) => {
      const frame = `${JSON.stringify(value)}\n`;
      if (!state.canSend()) return false;
      if (
        transportLimits !== undefined &&
        Buffer.byteLength(frame, "utf8") > transportLimits.maxFrameBytes
      ) {
        state.overflow("outbound-frame-bytes");
        return false;
      }
      if (writeBlocked && transportLimits !== undefined) {
        state.overflow("outbound-backpressure");
        return false;
      }
      if (!outgoing.write(frame)) {
        writeBlocked = true;
        state.recordOutboundBackpressure();
      }
      return true;
    },
    messages: state.messages,
    close: state.close,
    diagnostics: state.diagnostics,
    closed,
  };
}

type QueuedNdjsonMessage = { value: unknown; bytes: number };

type NdjsonStateOptions = {
  close(): void;
  destroy(): void;
  onFinish(): void;
};

function createNdjsonState(
  options: NdjsonStateOptions,
  transportLimits: NdjsonTransportLimits | undefined,
) {
  let buffer = "";
  let queue: QueuedNdjsonMessage[] = [];
  let queuedBytes = 0;
  let done = false;
  let closeRequested = false;
  let streamError: Error | undefined;
  const waiters: Array<() => void> = [];
  const metrics: NdjsonTransportDiagnostics = {
    inboundQueueDepth: 0,
    inboundQueueBytes: 0,
    inboundHighWaterDepth: 0,
    inboundHighWaterBytes: 0,
    outboundBackpressureCount: 0,
    overflowCount: 0,
    closeCount: 0,
  };

  const wake = () => {
    while (waiters.length > 0) waiters.shift()?.();
  };
  const updateDepth = () => {
    metrics.inboundQueueDepth = queue.length;
    metrics.inboundQueueBytes = queuedBytes;
    metrics.inboundHighWaterDepth = Math.max(metrics.inboundHighWaterDepth, queue.length);
    metrics.inboundHighWaterBytes = Math.max(metrics.inboundHighWaterBytes, queuedBytes);
  };
  const clearQueued = () => {
    buffer = "";
    queue = [];
    queuedBytes = 0;
    updateDepth();
  };
  const finish = (error?: Error) => {
    if (done) return;
    done = true;
    streamError = error ?? streamError;
    metrics.closeCount += 1;
    wake();
    options.onFinish();
  };
  const overflow = (reason: NdjsonTransportOverflowReason) => {
    if (done) return;
    metrics.overflowCount += 1;
    metrics.lastOverflowReason = reason;
    clearQueued();
    streamError = transportOverflowError(reason);
    finish(streamError);
    options.destroy();
  };
  const ingest = (chunk: string) => {
    if (done || closeRequested) return;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (
          transportLimits !== undefined &&
          Buffer.byteLength(buffer, "utf8") > transportLimits.maxFrameBytes
        ) {
          overflow("partial-frame-bytes");
        }
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const frameBytes = Buffer.byteLength(line, "utf8") + 1;
      if (transportLimits !== undefined && frameBytes > transportLimits.maxFrameBytes) {
        overflow("frame-bytes");
        return;
      }
      if (line.trim().length === 0) continue;
      if (transportLimits !== undefined && queue.length >= transportLimits.maxQueuedFrames) {
        overflow("queued-frames");
        return;
      }
      if (
        transportLimits !== undefined &&
        queuedBytes + frameBytes > transportLimits.maxQueuedBytes
      ) {
        overflow("queued-bytes");
        return;
      }
      try {
        queue.push({ value: JSON.parse(line), bytes: frameBytes });
        queuedBytes += frameBytes;
        updateDepth();
        wake();
      } catch (error) {
        streamError = error instanceof Error ? error : new Error("Invalid NDJSON frame.");
        clearQueued();
        finish(streamError);
        options.destroy();
        return;
      }
    }
  };
  const close = () => {
    if (closeRequested) return;
    closeRequested = true;
    clearQueued();
    options.close();
  };
  const messages = (): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        for (;;) {
          const message = queue.shift();
          if (message !== undefined) {
            queuedBytes -= message.bytes;
            updateDepth();
            return { done: false, value: message.value };
          }
          if (streamError !== undefined) throw streamError;
          if (done) return { done: true, value: undefined };
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
      return: async () => {
        close();
        return { done: true, value: undefined };
      },
    }),
  });
  const diagnostics = (): NdjsonTransportDiagnostics => ({ ...metrics });

  return {
    canSend: () => !done && !closeRequested,
    close,
    diagnostics,
    finish,
    ingest,
    messages,
    overflow,
    recordOutboundBackpressure: () => {
      metrics.outboundBackpressureCount += 1;
    },
  };
}

function transportOverflowError(reason: NdjsonTransportOverflowReason): Error {
  const safeError = protocolSafeError({
    code: "PROTOCOL_TRANSPORT_OVERFLOW",
    message: "NDJSON transport capacity was exceeded.",
    hint: "Reconnect and load a fresh snapshot before continuing.",
  });
  return Object.assign(new Error(safeError.message), safeError, {
    reason,
  });
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

function runLsof(file: string, args: readonly string[], timeoutMs: number) {
  return spawnSync(file, [...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

function socketEvidenceUnavailable(socketPath: string): Error & SafeError {
  const safeError = protocolSafeError({
    code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE",
    message: `Could not determine process ownership for Unix socket ${socketPath}.`,
  });
  return Object.assign(new Error(safeError.message), safeError);
}
