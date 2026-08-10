import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ORPHAN_TTL_MS,
  bridgeControlSocketPath,
  bridgeParkStatePath,
  bridgeScrollbackExportPath,
  reapStaleOrphanBridges,
  resolveOrphanTtlMs,
  waitForParkedBridge,
} from "../orphanBridges.js";
import net from "node:net";

describe("waitForParkedBridge", () => {
  it("returns true once a control socket answers exit-status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-wait-park-"));
    const socketPath = bridgeControlSocketPath(directory, "pty-1");
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(`${JSON.stringify({ type: "exit-status", exited: false })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        waitForParkedBridge(socketPath, { timeoutMs: 1_000, probeTimeoutMs: 100 }),
      ).resolves.toEqual(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns false when nothing listens before the deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-wait-miss-"));
    await expect(
      waitForParkedBridge(bridgeControlSocketPath(directory, "pty-missing"), {
        timeoutMs: 120,
        probeTimeoutMs: 30,
        intervalMs: 20,
      }),
    ).resolves.toEqual(false);
  });
});

describe("resolveOrphanTtlMs", () => {
  it("keeps the default for absent or unparsable overrides", () => {
    expect(resolveOrphanTtlMs(undefined)).toEqual(DEFAULT_ORPHAN_TTL_MS);
    expect(resolveOrphanTtlMs("")).toEqual(DEFAULT_ORPHAN_TTL_MS);
    expect(resolveOrphanTtlMs("soon")).toEqual(DEFAULT_ORPHAN_TTL_MS);
    expect(resolveOrphanTtlMs("-5")).toEqual(DEFAULT_ORPHAN_TTL_MS);
    expect(resolveOrphanTtlMs("1.5")).toEqual(DEFAULT_ORPHAN_TTL_MS);
  });

  it("accepts a positive integer override", () => {
    expect(resolveOrphanTtlMs("60000")).toEqual(60_000);
  });
});

describe("reapStaleOrphanBridges", () => {
  it("returns zeros for an absent directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-reap-"));
    const result = await reapStaleOrphanBridges(join(directory, "missing"));
    expect(result).toEqual({ reaped: 0, parked: 0 });
  });

  it("reaps dead sockets with their park and scrollback files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-reap-"));
    // A socket file nothing listens on is stale by definition.
    await writeFile(bridgeControlSocketPath(directory, "pty-9"), "");
    await writeFile(bridgeParkStatePath(directory, "pty-9"), "{}");
    await writeFile(bridgeScrollbackExportPath(directory, "pty-9"), "{}");

    const result = await reapStaleOrphanBridges(directory);
    expect(result).toEqual({ reaped: 1, parked: 0 });
    expect(existsSync(bridgeControlSocketPath(directory, "pty-9"))).toEqual(false);
    expect(existsSync(bridgeParkStatePath(directory, "pty-9"))).toEqual(false);
    expect(existsSync(bridgeScrollbackExportPath(directory, "pty-9"))).toEqual(false);
  });

  it("reaps a lone park state whose socket is already gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-reap-"));
    await writeFile(bridgeParkStatePath(directory, "pty-4"), "{}");

    const result = await reapStaleOrphanBridges(directory);
    expect(result).toEqual({ reaped: 1, parked: 0 });
    expect(existsSync(bridgeParkStatePath(directory, "pty-4"))).toEqual(false);
  });

  it("leaves unrelated files untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-reap-"));
    await writeFile(join(directory, "diagnostic-notes.txt"), "keep");
    const result = await reapStaleOrphanBridges(directory);
    expect(result).toEqual({ reaped: 0, parked: 0 });
    expect(existsSync(join(directory, "diagnostic-notes.txt"))).toEqual(true);
  });
});
