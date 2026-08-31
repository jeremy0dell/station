import { once } from "node:events";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  connectUnixSocket,
  inMemoryNdjsonConnectionPair,
  listenUnixSocket,
  NDJSON_TRANSPORT_LIMITS,
  probeUnixSocket,
  readUnixSocketHolderPids,
  readUnixSocketHolderPidsAsync,
} from "@station/protocol";
import * as runtime from "@station/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealStaleSocket, createTempSocketPath } from "../../../../tests/support/sockets";

describe("Unix socket NDJSON transport", () => {
  afterEach(() => vi.restoreAllMocks());
  it("exchanges newline-delimited JSON frames over a Unix socket", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: async (connection) => {
        for await (const message of connection.messages()) {
          connection.send({ ok: true, echo: message });
          connection.close();
        }
      },
    });

    const client = await connectUnixSocket(socketPath);
    client.send({ hello: "world" });

    const iterator = client.messages()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { ok: true, echo: { hello: "world" } },
    });

    client.close();
    await server.close();
  });

  it("disconnects before a non-consuming client can retain an unbounded frame backlog", async () => {
    const { socketPath } = await createTempSocketPath();
    let accepted: Socket | undefined;
    const server = createServer((socket) => {
      accepted = socket;
      socket.on("error", () => undefined);
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = await connectUnixSocket(socketPath);
    await waitFor(() => accepted !== undefined);

    try {
      const frame = `${JSON.stringify({ payload: "x".repeat(4_000) })}\n`;
      for (let index = 0; index < 2_048 && accepted?.destroyed === false; index += 1) {
        if (!accepted.write(frame)) {
          if ((await waitForDrainOrClose(accepted)) === "closed") break;
        }
      }

      await expect(settlesWithin(client.closed, 500)).resolves.toBe(true);
      expect(client.diagnostics()).toMatchObject({
        inboundQueueDepth: 0,
        inboundHighWaterDepth: NDJSON_TRANSPORT_LIMITS.maxQueuedFrames,
        overflowCount: 1,
        closeCount: 1,
        lastOverflowReason: "queued-frames",
      });
      expect(client.diagnostics().inboundHighWaterBytes).toBeLessThanOrEqual(
        NDJSON_TRANSPORT_LIMITS.maxQueuedBytes,
      );
    } finally {
      client.close();
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes the connection when its message iterator is returned", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const client = await connectUnixSocket(socketPath);
    const iterator = client.messages()[Symbol.asyncIterator]();

    await iterator.return?.();

    await expect(settlesWithin(client.closed, 500)).resolves.toBe(true);
    expect(client.diagnostics().closeCount).toBe(1);
    await server.close();
  });

  it("rejects oversized outbound and partial frames without retaining their contents", async () => {
    const outboundPair = inMemoryNdjsonConnectionPair();
    expect(
      outboundPair.client.send({ payload: "x".repeat(NDJSON_TRANSPORT_LIMITS.maxFrameBytes) }),
    ).toBe(false);
    expect(outboundPair.client.diagnostics()).toMatchObject({
      inboundQueueDepth: 0,
      overflowCount: 1,
      lastOverflowReason: "outbound-frame-bytes",
    });

    const { socketPath } = await createTempSocketPath();
    let accepted: Socket | undefined;
    const server = createServer((socket) => {
      accepted = socket;
      socket.on("error", () => undefined);
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = await connectUnixSocket(socketPath);
    await waitFor(() => accepted !== undefined);

    try {
      const chunk = "x".repeat(1024 * 1024);
      for (
        let bytes = 0;
        bytes <= NDJSON_TRANSPORT_LIMITS.maxFrameBytes && accepted?.destroyed === false;
        bytes += chunk.length
      ) {
        if (!accepted.write(chunk) && (await waitForDrainOrClose(accepted)) === "closed") break;
      }
      await expect(settlesWithin(client.closed, 2_000)).resolves.toBe(true);
      expect(client.diagnostics()).toMatchObject({
        inboundQueueDepth: 0,
        overflowCount: 1,
        lastOverflowReason: "partial-frame-bytes",
      });
    } finally {
      client.close();
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("creates a user-only socket directory and classifies socket states", async () => {
    const { socketPath } = await createTempSocketPath();
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await expect(probeUnixSocket(socketPath)).resolves.toEqual({ status: "absent" });
    await createRealStaleSocket(socketPath);

    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "stale" });

    const server = await listenUnixSocket({
      socketPath,
      onConnection: () => undefined,
    });
    const dirMode = (await stat(dirname(socketPath))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });

    await server.close();
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a stale socket file on its own during listen", async () => {
    const { socketPath } = await createTempSocketPath();
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await createRealStaleSocket(socketPath);
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "stale" });

    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    await server.close();
  });

  it("refuses to bind (and never unlinks) while another server is live on the path", async () => {
    const { socketPath } = await createTempSocketPath();
    const live = await listenUnixSocket({ socketPath, onConnection: () => undefined });

    await expect(
      listenUnixSocket({ socketPath, onConnection: () => undefined }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    // The live server is untouched and still accepting.
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });

    await live.close();
  });

  it.each(["EACCES", "EPERM"])("fails closed for %s without consulting holders", async (code) => {
    const socketHolders = vi.fn(() => []);
    const result = await probeUnixSocket("/tmp/inaccessible.sock", {
      readMetadata: async () => metadata(1n),
      connect: async () => {
        throw Object.assign(new Error(code), { code });
      },
      socketHolders,
    });

    expect(result).toMatchObject({
      status: "inaccessible",
      reason: "permission-denied",
      error: { code: "PROTOCOL_SOCKET_INACCESSIBLE" },
    });
    expect(socketHolders).not.toHaveBeenCalled();
  });

  it("fails closed for connect timeout and unclassified failures", async () => {
    const timeout = await probeUnixSocket("/tmp/timeout.sock", {
      readMetadata: async () => metadata(1n),
      connect: async () => {
        throw { tag: "TimeoutError", code: "PROTOCOL_CONNECT_TIMEOUT", message: "timeout" };
      },
    });
    expect(timeout).toMatchObject({ status: "inaccessible", reason: "timeout" });

    const unknown = await probeUnixSocket("/tmp/unknown.sock", {
      readMetadata: async () => metadata(1n),
      connect: async () => {
        throw Object.assign(new Error("unknown"), { code: "EIO" });
      },
    });
    expect(unknown).toMatchObject({ status: "inaccessible", reason: "unclassified" });
  });

  it("requires zero-holder evidence for refused and Bun-style ENOENT connections", async () => {
    for (const code of ["ECONNREFUSED", "ENOENT"]) {
      const stale = await probeUnixSocket("/tmp/dead.sock", {
        readMetadata: async () => metadata(1n),
        connect: async () => {
          throw Object.assign(new Error(code), { code });
        },
        socketHolders: () => [],
      });
      expect(stale).toMatchObject({ status: "stale" });
    }

    const held = await probeUnixSocket("/tmp/held.sock", {
      readMetadata: async () => metadata(1n),
      connect: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      socketHolders: () => [42],
    });
    expect(held).toMatchObject({ status: "inaccessible", reason: "live-holder" });

    const unavailable = await probeUnixSocket("/tmp/unknown-owner.sock", {
      readMetadata: async () => metadata(1n),
      connect: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      socketHolders: () => {
        throw { code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" };
      },
    });
    expect(unavailable).toMatchObject({
      status: "inaccessible",
      reason: "evidence-unavailable",
    });
  });

  it.each([
    { name: "absence", final: undefined, expected: { status: "absent" } },
    {
      name: "replacement socket",
      final: metadata(2n),
      expected: { status: "inaccessible", reason: "path-changed" },
    },
    {
      name: "non-socket collision",
      final: { ...metadata(1n), isSocket: false },
      expected: { status: "inaccessible", reason: "not-a-socket" },
    },
  ] as const)("reclassifies $name after holder evidence races path teardown", async (testCase) => {
    let reads = 0;
    const result = await probeUnixSocket("/tmp/closing.sock", {
      readMetadata: async () => {
        reads += 1;
        return reads < 3 ? metadata(1n) : testCase.final;
      },
      connect: async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      socketHolders: () => {
        throw { code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" };
      },
    });

    expect(result).toMatchObject(testCase.expected);
    expect(reads).toBe(3);
  });

  it("fails closed when the socket path changes during probing or is not a socket", async () => {
    let reads = 0;
    const changed = await probeUnixSocket("/tmp/replaced.sock", {
      readMetadata: async () => {
        reads += 1;
        return metadata(reads === 1 ? 1n : 2n);
      },
      connect: async () => undefined,
    });
    expect(changed).toMatchObject({ status: "inaccessible", reason: "path-changed" });

    const { socketPath } = await createTempSocketPath();
    await writeFile(socketPath, "collision", { mode: 0o600 });
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({
      status: "inaccessible",
      reason: "not-a-socket",
    });
    await expect(access(socketPath)).resolves.toBeUndefined();
  });

  it("strictly parses lsof holders and accepts only its canonical empty status-1 result", () => {
    const result = (status: number | null, stdout: string, stderr = "") => ({
      status,
      stdout,
      stderr,
      signal: null,
    });
    expect(
      readUnixSocketHolderPids("/tmp/socket", {
        runLsof: () => result(0, "10\n20\n10\n"),
      }),
    ).toEqual([10, 20]);
    expect(readUnixSocketHolderPids("/tmp/socket", { runLsof: () => result(1, "") })).toEqual([]);

    for (const commandResult of [
      result(0, ""),
      result(0, "10\ninvalid\n"),
      result(0, " 10\n"),
      result(0, "10 \n"),
      result(0, "+10\n"),
      result(0, "01\n"),
      result(0, "1e2\n"),
      result(0, "0x10\n"),
      result(0, "10\r\n"),
      result(0, "10\n\n"),
      result(0, `${Number.MAX_SAFE_INTEGER + 1}\n`),
      result(0, "10\n", "warning"),
      result(1, "10\n"),
      result(2, ""),
      { ...result(null, ""), signal: "SIGTERM" as const },
      { ...result(null, ""), error: new Error("missing lsof") },
    ]) {
      expect(() =>
        readUnixSocketHolderPids("/tmp/socket", { runLsof: () => commandResult }),
      ).toThrow(expect.objectContaining({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" }));
    }
  });

  it("uses the runtime boundary for asynchronous canonical holder evidence", async () => {
    const run = vi.spyOn(runtime, "runExternalCommand");
    run
      .mockResolvedValueOnce({
        command: "/usr/bin/lsof",
        args: ["-t", "/tmp/socket"],
        stdout: "10\n20\n10\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        command: "/usr/bin/lsof",
        args: ["-t", "/tmp/socket"],
        stdout: "",
        stderr: "",
        exitCode: 1,
      });

    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", { deadlineMs: Date.now() + 1_000 }),
    ).resolves.toEqual([10, 20]);
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", { deadlineMs: Date.now() + 1_000 }),
    ).resolves.toEqual([]);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
        args: ["-t", "/tmp/socket"],
        allowedExitCodes: [1],
      }),
    );
  });

  it.each([
    [0, "", ""],
    [0, " 10\n", ""],
    [0, "+10\n", ""],
    [0, "1e2\n", ""],
    [0, "0x10\n", ""],
    [0, "10\r\n", ""],
    [0, "10\n\n", ""],
    [0, "10\n", "warning"],
    [1, "10\n", ""],
    [2, "", ""],
  ])("fails closed for asynchronous status/output %#", async (exitCode, stdout, stderr) => {
    vi.spyOn(runtime, "runExternalCommand").mockResolvedValue({
      command: "/usr/bin/lsof",
      args: ["-t", "/tmp/socket"],
      stdout,
      stderr,
      exitCode,
    });
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", { deadlineMs: Date.now() + 1_000 }),
    ).rejects.toMatchObject({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" });
  });

  it("rejects pre-abort, execution uncertainty, late completion, and cancellation", async () => {
    const run = vi.spyOn(runtime, "runExternalCommand");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", {
        deadlineMs: Date.now() + 1_000,
        signal: alreadyAborted.signal,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();

    run.mockRejectedValueOnce(Object.assign(new Error("uncertain"), { signal: "SIGKILL" }));
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", { deadlineMs: Date.now() + 1_000 }),
    ).rejects.toMatchObject({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" });

    const result = {
      command: "/usr/bin/lsof",
      args: ["-t", "/tmp/socket"],
      stdout: "10\n",
      stderr: "",
      exitCode: 0,
    };
    run.mockResolvedValueOnce(result);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_000);
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", { deadlineMs: 1_500 }),
    ).rejects.toMatchObject({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" });
    vi.mocked(Date.now).mockRestore();

    const controller = new AbortController();
    run.mockImplementationOnce(async () => {
      controller.abort();
      return result;
    });
    await expect(
      readUnixSocketHolderPidsAsync("/tmp/socket", {
        deadlineMs: Date.now() + 1_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" });
  });

  it("bounds holder evidence with the caller's socket-probe timeout", () => {
    let observedTimeoutMs: number | undefined;
    expect(() =>
      readUnixSocketHolderPids("/tmp/socket", {
        timeoutMs: 25,
        runLsof: (_file, _args, timeoutMs) => {
          observedTimeoutMs = timeoutMs;
          return {
            status: null,
            stdout: "",
            stderr: "",
            signal: "SIGKILL",
            error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          };
        },
      }),
    ).toThrow(expect.objectContaining({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" }));
    expect(observedTimeoutMs).toBe(25);
  });

  it("abandons a displaced listener without deleting its successor pathname", async () => {
    const { socketPath } = await createTempSocketPath();
    const displaced = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    await unlink(socketPath);
    const successor = await listenUnixSocket({ socketPath, onConnection: () => undefined });

    displaced.abandon();
    await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    await successor.close();
  });

  it("relays frames both ways over an in-memory connection pair", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    const serverIterator = server.messages()[Symbol.asyncIterator]();
    const clientIterator = client.messages()[Symbol.asyncIterator]();

    client.send({ from: "client" });
    await expect(serverIterator.next()).resolves.toEqual({
      done: false,
      value: { from: "client" },
    });

    server.send({ from: "server" });
    await expect(clientIterator.next()).resolves.toEqual({
      done: false,
      value: { from: "server" },
    });
  });

  it("completes the peer stream and resolves closed when one end closes", async () => {
    const { client, server } = inMemoryNdjsonConnectionPair();
    const serverIterator = server.messages()[Symbol.asyncIterator]();

    client.close();
    await expect(serverIterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(server.closed).resolves.toBeUndefined();
  });

  it("closes even when a client connection is still open", async () => {
    const { socketPath } = await createTempSocketPath();
    const server = await listenUnixSocket({
      socketPath,
      onConnection: () => undefined,
    });
    const client = await connectUnixSocket(socketPath);

    await expect(server.close()).resolves.toBeUndefined();
    await expect(client.closed).resolves.toBeUndefined();
  });
});

function metadata(ino: bigint) {
  return { ino, birthtimeNs: ino * 10n, isSocket: true };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for transport test state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForDrainOrClose(socket: Socket): Promise<"drain" | "closed"> {
  return new Promise((resolve) => {
    const finish = (result: "drain" | "closed") => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(result);
    };
    const onDrain = () => finish("drain");
    const onClose = () => finish("closed");
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onClose);
  });
}
