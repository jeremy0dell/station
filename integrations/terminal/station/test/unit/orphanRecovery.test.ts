import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PtyBridgeParkState, PtyHandoffManifest } from "@station/contracts";
import { HOST_PROTOCOL_VERSION, type StationHostClient } from "@station/host";
import { describe, expect, it, vi } from "vitest";
import { createStationHostController } from "../../src/host/hostController.js";
import { loadParkedOrphanManifest } from "../../src/host/orphanRecovery.js";

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
    const controller = createStationHostController(
      {
        socketPath: path.join(stateDir, "station-host.sock"),
        stateDir,
        hostCommand: ["station-host"],
        expectedBuildVersion: "test-build",
      },
      {
        clientFactory: () => client,
        spawnHost: () => ({ pid: 42, unref: () => undefined }),
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
