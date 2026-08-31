import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PtyBridgeParkState, PtyHandoffManifest } from "@station/contracts";
import {
  HOST_PROTOCOL_VERSION,
  type StationHostClient,
  type StationHostLifecycleSession,
} from "@station/host";
import type { ChildProcessLike } from "@station/terminal";
import { describe, expect, it, vi } from "vitest";
import { createStationHostController } from "../../src/host/hostController.js";
import {
  adoptParkedOrphanManifest,
  loadParkedOrphanManifest,
} from "../../src/host/orphanRecovery.js";

class FakeChild extends EventEmitter {
  pid = 42;
  kill(): boolean {
    this.emit("exit", 0, null);
    return true;
  }
  unref(): this {
    return this;
  }
}

describe("loadParkedOrphanManifest", () => {
  it("returns only non-exited strict park records with their expected control socket", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "station-orphan-recovery-"));
    const directory = path.join(stateDir, "run", "pty-bridges");
    await mkdir(directory, { recursive: true });
    const controlSocket = path.join(directory, "pty-live.sock");
    const park = parkRecord(controlSocket);
    await writeFile(path.join(directory, "pty-live.park.json"), JSON.stringify(park));
    await writeFile(
      path.join(directory, "pty-exited.park.json"),
      JSON.stringify({
        ...park,
        controlSocket: path.join(directory, "pty-exited.sock"),
        exited: true,
      }),
    );

    await expect(loadParkedOrphanManifest(stateDir)).resolves.toEqual({
      "pty-live": expect.objectContaining({
        controlSocket,
        identity: expect.objectContaining({ sessionId: "ses_feature" }),
      }),
    });
  });

  it("fails closed on malformed parked recovery evidence", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "station-orphan-recovery-invalid-"));
    const directory = path.join(stateDir, "run", "pty-bridges");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "pty-invalid.park.json"), "{}\n");

    await expect(loadParkedOrphanManifest(stateDir)).rejects.toMatchObject({
      code: "HOST_HANDOFF_MANIFEST_INVALID",
    });
  });

  it("fails closed when a parked record names another bridge's socket", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "station-orphan-recovery-socket-"));
    const directory = path.join(stateDir, "run", "pty-bridges");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "pty-wrong.park.json"),
      JSON.stringify(parkRecord(path.join(directory, "pty-other.sock"))),
    );

    await expect(loadParkedOrphanManifest(stateDir)).rejects.toMatchObject({
      code: "HOST_HANDOFF_MANIFEST_INVALID",
    });
  });
});

describe("createStationHostController orphan recovery", () => {
  it("starts a successor Host and adopts every remaining parked bridge", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "station-orphan-controller-"));
    const directory = path.join(stateDir, "run", "pty-bridges");
    await mkdir(directory, { recursive: true });
    const controlSocket = path.join(directory, "pty-live.sock");
    await writeFile(
      path.join(directory, "pty-live.park.json"),
      JSON.stringify(parkRecord(controlSocket)),
    );
    const adoptRegistry = vi.fn(async (manifest: PtyHandoffManifest) => ({
      adopted: Object.keys(manifest),
      failed: [],
    }));
    const client = fakeHostClient({ adoptRegistry });
    const socketPath = path.join(stateDir, "station-host.sock");
    const endpoint = { socketPath, ino: 1n, birthtimeNs: 2n };
    const lifecycle = fakeLifecycleSession();
    const controller = createStationHostController(
      {
        socketPath,
        stateDir,
        hostCommand: ["station-host"],
        expectedBuildVersion: "test-build",
      },
      {
        clientFactory: () => client,
        spawnHost: () => new FakeChild() as unknown as ChildProcessLike,
        readiness: {
          probeEndpoint: async () => ({ status: "listening", endpoint }),
          openSession: async () => lifecycle,
          readHolders: async () => [42],
        },
      },
    );

    await expect(controller.recoverOrphanedTargets()).resolves.toBe(true);
    expect(adoptRegistry).toHaveBeenCalledWith({
      "pty-live": expect.objectContaining({
        controlSocket,
        identity: expect.objectContaining({ sessionId: "ses_feature" }),
      }),
    });
  });
});

describe("adoptParkedOrphanManifest", () => {
  it("requires the exact expected PTY set and no failed entries", async () => {
    const manifest = { "pty-live": parkManifestEntry("/tmp/pty-live.sock") };
    await expect(
      adoptParkedOrphanManifest(
        { adoptRegistry: async () => ({ adopted: [], failed: [] }) },
        manifest,
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    await expect(
      adoptParkedOrphanManifest(
        {
          adoptRegistry: async () => ({
            adopted: ["pty-live"],
            failed: [{ ptyId: "pty-live", reason: "failed" }],
          }),
        },
        manifest,
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
    await expect(
      adoptParkedOrphanManifest(
        { adoptRegistry: async () => ({ adopted: ["pty-other"], failed: [] }) },
        manifest,
      ),
    ).rejects.toMatchObject({ code: "HOST_HANDOFF_MANIFEST_INVALID" });
  });
});

function fakeHostClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "test-build",
    }),
    stopIfIdle: async () => ({ stopping: true }),
    beginHandoff: async () => ({
      manifest: {},
      fidelity: "processes",
      released: [],
      skipped: [],
    }),
    completeHandoff: async () => ({ stopping: true }),
    abortHandoff: async () => ({ adopted: [], failed: [] }),
    adoptRegistry: async () => ({ adopted: [], failed: [] }),
    spawn: async () => ({
      terminalTargetId: "native:unused",
      ptyId: "unused",
      ptyInstanceId: "instance-unused",
      pid: 1,
    }),
    list: async () => [],
    recoveryInventory: async () => ({ buildIdentity: "a".repeat(64), ptys: [] }),
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("unused");
    },
    dispose: () => undefined,
    ...overrides,
  };
}

function fakeLifecycleSession(): StationHostLifecycleSession {
  return {
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: "test-build",
    }),
    recoveryInventory: async () => ({ buildIdentity: "a".repeat(64), ptys: [] }),
    stopIfIdle: async () => ({ stopping: true }),
    beginHandoff: async () => ({
      status: "refused",
      error: { tag: "HostError", code: "NOT_USED", message: "not used" },
    }),
    completeHandoff: async () => ({ stopping: true }),
    abortHandoff: async () => ({ adopted: [], failed: [] }),
    adoptRegistry: async () => ({ adopted: [], failed: [] }),
    dispose: () => undefined,
  };
}

function parkManifestEntry(controlSocket: string): PtyHandoffManifest[string] {
  const park = parkRecord(controlSocket);
  return {
    bridgeProtocolVersion: 2,
    bridgePid: park.bridgePid,
    controlSocket,
    command: park.command,
    cols: park.cols,
    rows: park.rows,
    ptyInstanceId: park.ptyInstanceId,
    identity: park.identity,
  };
}

function parkRecord(controlSocket: string): PtyBridgeParkState {
  return {
    v: 2,
    bridgePid: 12,
    pid: 34,
    controlSocket,
    command: "codex",
    cols: 100,
    rows: 30,
    ptyInstanceId: "instance-pty-1",
    identity: {
      kind: "agent",
      terminalTargetId: "native:wt_feature",
      worktreeId: "wt_feature",
      projectId: "project",
      sessionId: "ses_feature",
      worktreePath: "/tmp/project/feature",
      harnessProvider: "codex",
    },
    orphanedAtMs: 1,
    ttlMs: 60_000,
    heartbeatAtMs: 2,
    exited: false,
  };
}

import { EventEmitter } from "node:events";
