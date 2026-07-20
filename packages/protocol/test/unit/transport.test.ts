import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  connectUnixSocket,
  inMemoryNdjsonConnectionPair,
  listenUnixSocket,
  probeUnixSocket,
  readUnixSocketHolderPids,
} from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRealStaleSocket, createTempSocketPath } from "../../../../tests/support/sockets";

describe("Unix socket NDJSON transport", () => {
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
