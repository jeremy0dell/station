import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_PROTOCOL_VERSION } from "@station/contracts";
import { type StationHostLifecycleSession, stationHostSafeError } from "@station/host";
import type { ChildProcessLike } from "@station/terminal";
import { describe, expect, it, vi } from "vitest";
import { startStationHostWithOwnershipProof } from "../../src/host/startStationHostWithOwnershipProof.js";

const expectedBuildVersion = "test-build";

class FakeChild extends EventEmitter {
  pid: number | undefined = 42;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.emit("exit", 0, signal ?? null);
    return true;
  }
  unref(): this {
    return this;
  }
}

function lifecycleSession(
  health: StationHostLifecycleSession["health"] = vi.fn(async () => ({
    ok: true,
    protocolVersion: HOST_PROTOCOL_VERSION,
    buildVersion: expectedBuildVersion,
  })),
): StationHostLifecycleSession {
  return {
    health,
    recoveryInventory: vi.fn(async () => ({ buildIdentity: "a".repeat(64), ptys: [] })),
    stopIfIdle: vi.fn(async () => ({ stopping: true })),
    beginHandoff: vi.fn(async () => ({
      status: "refused",
      error: stationHostSafeError("HOST_UPGRADE_BLOCKED", "not used"),
    })),
    completeHandoff: vi.fn(async () => ({ stopping: true })),
    abortHandoff: vi.fn(async () => ({ adopted: [], failed: [] })),
    adoptRegistry: vi.fn(async () => ({ adopted: [], failed: [] })),
    dispose: vi.fn(),
  };
}

describe("Station Host startup ownership proof", () => {
  it.each([
    "endpoint",
    "health",
    "holder",
  ] as const)("fails and settles the child on %s substitution", async (substitution) => {
    const socketPath = join(tmpdir(), `station-host-proof-${process.pid}.sock`);
    const endpoint = { socketPath, ino: 1n, birthtimeNs: 2n };
    const child = new FakeChild();
    const session = lifecycleSession(
      substitution === "health"
        ? vi
            .fn()
            .mockResolvedValueOnce({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: expectedBuildVersion,
            })
            .mockResolvedValueOnce({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "changed",
            })
        : undefined,
    );
    let probes = 0;
    const result = await startStationHostWithOwnershipProof(
      {
        socketPath,
        stateDir: tmpdir(),
        hostCommand: ["station-host"],
        detached: true,
        expectedBuildVersion,
        startupCutoffMs: 2_000,
        deadlineMs: 4_000,
      },
      {
        now: () => 1_000,
        spawnHost: () => child as unknown as ChildProcessLike,
        openSession: async () => session,
        readHolders: async () => (substitution === "holder" ? [99] : [42]),
        probeEndpoint: async () => {
          probes += 1;
          return {
            status: "listening",
            endpoint:
              substitution === "endpoint" && probes >= 2 ? { ...endpoint, ino: 9n } : endpoint,
          };
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", childDisposition: "settled" });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});
