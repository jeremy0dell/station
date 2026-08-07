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
} from "./orphanBridges.js";

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
