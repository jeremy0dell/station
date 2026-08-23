import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PtyHandoffManifest,
  PtyLifetimeIdentity,
  UpdateHostConvergenceCommand,
} from "@station/contracts";
import { HOST_PROTOCOL_VERSION, type StationHostClient, stationHostSafeError } from "@station/host";
import { listenUnixSocket, probeUnixSocket } from "@station/protocol";
import {
  adoptHandoffManifest,
  type ChildProcessLike,
  convergeStationHostForUpdate,
  ensureStationHostRunning,
  type SpawnStationHostInput,
} from "@station/terminal";
import { describe, expect, it, vi } from "vitest";

const expectedBuildVersion = "test-build";
const incumbentBuildIdentity = "a".repeat(64);
const targetBuildIdentity = "b".repeat(64);

function fakeClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: expectedBuildVersion,
    }),
    stopIfIdle: async () => ({ stopping: true }),
    beginHandoff: async () => ({
      manifest: {},
      fidelity: "processes" as const,
      released: [],
      skipped: [],
    }),
    completeHandoff: async () => ({ stopping: true as const }),
    abortHandoff: async () => ({ adopted: [], failed: [] }),
    adoptRegistry: async () => ({ adopted: [], failed: [] }),
    spawn: async () => ({
      terminalTargetId: "native:p",
      ptyId: "p",
      ptyInstanceId: "instance-p",
      pid: 1,
    }),
    list: async () => [],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("not used");
    },
    dispose: () => undefined,
    ...overrides,
  };
}

function absentSocketPath(): string {
  return join(
    tmpdir(),
    `station-host-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function twoEntryHandoffManifest(): PtyHandoffManifest {
  return Object.fromEntries(
    ["1", "2"].map((identity) => [
      `pty-${identity}`,
      {
        bridgeProtocolVersion: 2 as const,
        bridgePid: 4200 + Number(identity),
        controlSocket: `/tmp/pty-${identity}.sock`,
        command: "/bin/sh",
        cols: 80,
        rows: 24,
        ptyInstanceId: `instance-pty-${identity}`,
        identity: {
          kind: "agent" as const,
          terminalTargetId: `native:wt-${identity}`,
          worktreeId: `wt-${identity}`,
          projectId: "proj-1",
          sessionId: `ses-${identity}`,
          worktreePath: `/repo/wt-${identity}`,
          harnessProvider: "claude",
        },
      },
    ]),
  );
}

function terminalIdentities(manifest: PtyHandoffManifest): PtyLifetimeIdentity[] {
  return Object.entries(manifest).map(([ptyId, entry]) => ({
    terminalTargetId: entry.identity.terminalTargetId,
    ptyId,
    ptyInstanceId: entry.ptyInstanceId,
  }));
}

function oneEntryHandoffManifest(ptyId: "pty-1" | "pty-2"): PtyHandoffManifest {
  const entry = twoEntryHandoffManifest()[ptyId];
  if (entry === undefined) throw new Error(`Missing ${ptyId} handoff fixture.`);
  return { [ptyId]: entry };
}

function recoveryPtys(manifest: PtyHandoffManifest) {
  return Object.entries(manifest).map(([ptyId, entry], index) => ({
    ...entry.identity,
    ptyId,
    ptyInstanceId: entry.ptyInstanceId,
    pid: 4300 + index,
    alive: true,
    cols: entry.cols,
    rows: entry.rows,
    handoffSupport: { kind: "bridge-releasable" as const },
  }));
}

function convergenceCommand(
  action: "replace-idle" | "handoff",
  terminals: PtyLifetimeIdentity[],
): UpdateHostConvergenceCommand {
  const commitment = {
    incumbent: {
      buildVersion: { status: "known" as const, value: "older-build" },
      buildIdentity: { status: "known" as const, value: incumbentBuildIdentity },
      protocolVersion: HOST_PROTOCOL_VERSION,
      inventory: { terminals },
    },
    target: {
      buildVersion: expectedBuildVersion,
      buildIdentity: targetBuildIdentity,
    },
  };
  return action === "replace-idle"
    ? { schemaVersion: 1, action, commitment }
    : { schemaVersion: 1, action, fidelity: "processes", commitment };
}

async function liveSocket(): Promise<{ socketPath: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "station-host-test-"));
  const socketPath = join(directory, "host.sock");
  const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
  let closed = false;
  return {
    socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("ensureStationHostRunning", () => {
  it.each([
    { name: "same-count wrong", adopted: ["pty-1", "pty-wrong"] },
    { name: "duplicate", adopted: ["pty-1", "pty-1"] },
  ])("rejects a $name adopted PTY id set", async ({ adopted }) => {
    const result = await adoptHandoffManifest(
      fakeClient({ adoptRegistry: async () => ({ adopted, failed: [] }) }),
      twoEntryHandoffManifest(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HOST_HANDOFF_MANIFEST_INVALID" },
    });
  });
  it("reports unavailable when no host entry is configured", async () => {
    const handle = await ensureStationHostRunning(
      {
        socketPath: absentSocketPath(),
        stateDir: tmpdir(),
        hostCommand: [""],
        expectedBuildVersion,
      },
      { clientFactory: () => fakeClient() },
    );
    expect(handle.status).toBe("unavailable");
    if (handle.status === "unavailable") {
      expect(handle.error.code).toBe("HOST_UNREACHABLE");
    }
  });

  it("spawns the host detached and reports running once healthy", async () => {
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    const handle = await ensureStationHostRunning(
      {
        socketPath: absentSocketPath(),
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        expectedBuildVersion,
      },
      { clientFactory: () => fakeClient(), spawnHost },
    );
    expect(handle).toMatchObject({ status: "running", ensuredBy: "start" });
    expect(spawnHost).toHaveBeenCalledTimes(1);
    expect(spawnHost.mock.calls[0]?.[0]).toEqual({
      argv: ["bun", "/tmp/hostMain.ts", "--socket", expect.any(String), "--state-dir", tmpdir()],
      spawnOptions: { detached: true, stdio: "ignore" },
    });
  });

  it("keeps a disposable runtime owner's Host in the foreground process group", async () => {
    vi.stubEnv("STATION_RUNTIME_OWNER_FOREGROUND", "1");
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );

    const handle = await ensureStationHostRunning(
      {
        socketPath: absentSocketPath(),
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        expectedBuildVersion,
      },
      { clientFactory: () => fakeClient(), spawnHost },
    );

    expect(handle).toMatchObject({ status: "running", ensuredBy: "start" });
    expect(spawnHost.mock.calls[0]?.[0].spawnOptions).toEqual({
      detached: false,
      stdio: "ignore",
    });
  });

  it("kills the spawned child and reports unavailable when it never gets healthy", async () => {
    const kill = vi.fn();
    const spawnHost = (_input: SpawnStationHostInput): ChildProcessLike => ({
      pid: 999,
      unref: () => undefined,
      kill,
    });
    const handle = await ensureStationHostRunning(
      {
        socketPath: absentSocketPath(),
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        expectedBuildVersion,
        timeoutMs: 120,
      },
      {
        clientFactory: () =>
          fakeClient({
            health: async () => {
              throw new Error("not up");
            },
          }),
        spawnHost,
      },
    );
    expect(handle.status).toBe("unavailable");
    expect(kill).toHaveBeenCalled();
  });

  it("reuses a host only when protocol and build versions exactly match", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const stopIfIdle = vi.fn(async () => ({ stopping: true as const }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    const client = fakeClient({ stopIfIdle });
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        { clientFactory: () => client, spawnHost },
      );

      expect(handle).toMatchObject({
        status: "running",
        socketPath,
        client,
        ensuredBy: "reuse",
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("preserves inaccessible Host ownership without health, spawn, or unlink", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const before = await lstat(socketPath, { bigint: true });
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    const clientFactory = vi.fn(() => {
      throw new Error("inaccessible ownership must not create a client");
    });
    try {
      await chmod(socketPath, 0o000);
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        { clientFactory, spawnHost },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_UNREACHABLE", hint: expect.stringContaining("do not unlink") },
      });
      const after = await lstat(socketPath, { bigint: true });
      expect({ ino: after.ino, birthtimeNs: after.birthtimeNs }).toEqual({
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
      });
      expect(clientFactory).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await chmod(socketPath, 0o600);
      await socket.close();
    }
  });

  it("stops an idle same-protocol host before spawning and validating the requested build", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    let healthCalls = 0;
    const stopIfIdle = vi.fn(async (requestingBuildVersion: string) => {
      expect(requestingBuildVersion).toBe(expectedBuildVersion);
      await socket.close();
      return { stopping: true as const };
    });
    const client = fakeClient({
      health: async () => {
        healthCalls += 1;
        return {
          ok: true,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
        };
      },
      stopIfIdle,
    });
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );

    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        { clientFactory: () => client, spawnHost },
      );

      expect(handle.status).toBe("running");
      expect(stopIfIdle).toHaveBeenCalledTimes(1);
      expect(spawnHost).toHaveBeenCalledTimes(1);
      expect(stopIfIdle.mock.invocationCallOrder[0]).toBeLessThan(
        spawnHost.mock.invocationCallOrder[0] ?? 0,
      );
      expect(healthCalls).toBe(2);
    } finally {
      await socket.close();
    }
  });

  it("preserves a different-build host when live PTYs block its idle shutdown", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const refusal = stationHostSafeError(
      "HOST_UPGRADE_BLOCKED",
      "Host build older-build owns 2 live terminals; requested build is test-build.",
    );
    const stopIfIdle = vi.fn(async () => {
      throw refusal;
    });
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_UPGRADE_BLOCKED" },
      });
      if (handle.status === "unavailable") {
        expect(handle.error).toBe(refusal);
      }
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("never handoffs on protocol refuse even when handoff is opted in", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const beginHandoff = vi.fn();
    const stopIfIdle = vi.fn();
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION - 1,
                buildVersion: "older-build",
              }),
              stopIfIdle,
              beginHandoff,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("does not abort after complete when socket release fails", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const abortHandoff = vi.fn(async () => ({ adopted: ["pty-1"], failed: [] }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          timeoutMs: 120,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff: async () => ({
                manifest: {
                  "pty-1": {
                    bridgeProtocolVersion: 2 as const,
                    bridgePid: 4242,
                    controlSocket: "/tmp/pty-1.sock",
                    command: "/bin/sh",
                    cols: 80,
                    rows: 24,
                    ptyInstanceId: "instance-pty-1",
                    identity: {
                      kind: "agent" as const,
                      terminalTargetId: "native:wt-1",
                      worktreeId: "wt-1",
                      projectId: "proj-1",
                      sessionId: "ses-1",
                      worktreePath: "/repo/wt-1",
                      harnessProvider: "claude",
                    },
                  },
                },
                fidelity: "processes" as const,
                released: ["pty-1"],
                skipped: [],
              }),
              completeHandoff: async () => ({ stopping: true as const }),
              abortHandoff,
            }),
          spawnHost,
        },
      );

      // complete committed but the incumbent socket never released.
      expect(handle).toMatchObject({
        status: "unavailable",
        error: {
          code: "HOST_UNREACHABLE",
          hint: expect.stringContaining(
            "Parked bridges remain under the state dir for successor recovery.",
          ),
        },
      });
      expect(abortHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("aborts after begin when completeHandoff fails and does not spawn", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const abortHandoff = vi.fn(async () => ({ adopted: ["pty-1"], failed: [] }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "screen" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff: async () => ({
                manifest: {
                  "pty-1": {
                    bridgeProtocolVersion: 2 as const,
                    bridgePid: 4242,
                    controlSocket: "/tmp/pty-1.sock",
                    command: "/bin/sh",
                    cols: 80,
                    rows: 24,
                    ptyInstanceId: "instance-pty-1",
                    identity: {
                      kind: "agent" as const,
                      terminalTargetId: "native:wt-1",
                      worktreeId: "wt-1",
                      projectId: "proj-1",
                      sessionId: "ses-1",
                      worktreePath: "/repo/wt-1",
                      harnessProvider: "claude",
                    },
                  },
                },
                fidelity: "screen" as const,
                released: ["pty-1"],
                skipped: [],
              }),
              completeHandoff: async () => {
                throw stationHostSafeError("HOST_UNREACHABLE", "socket closed mid-complete");
              },
              abortHandoff,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: {
          code: "HOST_UPGRADE_BLOCKED",
          message: "Host build older-build owns 1 live terminal.",
          hint: expect.stringContaining("socket closed mid-complete (HOST_UNREACHABLE)"),
        },
      });
      expect(abortHandoff).toHaveBeenCalledOnce();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("reports parked recovery when abort cannot prove incumbent restoration", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff: async () => ({
                manifest: {
                  "pty-1": {
                    bridgeProtocolVersion: 2 as const,
                    bridgePid: 4242,
                    controlSocket: "/tmp/pty-1.sock",
                    command: "/bin/sh",
                    cols: 80,
                    rows: 24,
                    ptyInstanceId: "instance-pty-1",
                    identity: {
                      kind: "agent" as const,
                      terminalTargetId: "native:wt-1",
                      worktreeId: "wt-1",
                      projectId: "proj-1",
                      sessionId: "ses-1",
                      worktreePath: "/repo/wt-1",
                      harnessProvider: "claude",
                    },
                  },
                },
                fidelity: "processes" as const,
                released: ["pty-1"],
                skipped: [],
              }),
              completeHandoff: async () => {
                throw stationHostSafeError("HOST_UNREACHABLE", "complete acknowledgement lost");
              },
              abortHandoff: async () => ({
                adopted: [],
                failed: [{ ptyId: "pty-1", reason: "bridge unavailable" }],
              }),
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: {
          code: "HOST_UNREACHABLE",
          message: "complete acknowledgement lost",
          hint: expect.stringContaining(
            "Parked bridges remain under the state dir for successor recovery.",
          ),
        },
      });
      if (handle.status === "unavailable") {
        expect(handle.error.hint).not.toContain("existing host and terminals were preserved");
      }
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("surfaces adopt failure after successor spawn without claiming running", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const manifest = {
      "pty-1": {
        bridgeProtocolVersion: 2 as const,
        bridgePid: 4242,
        controlSocket: "/tmp/pty-1.sock",
        command: "/bin/sh",
        cols: 80,
        rows: 24,
        ptyInstanceId: "instance-pty-1",
        identity: {
          kind: "agent" as const,
          terminalTargetId: "native:wt-1",
          worktreeId: "wt-1",
          projectId: "proj-1",
          sessionId: "ses-1",
          worktreePath: "/repo/wt-1",
          harnessProvider: "claude",
        },
      },
    };
    let healthCalls = 0;
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => {
                healthCalls += 1;
                return {
                  ok: true,
                  protocolVersion: HOST_PROTOCOL_VERSION,
                  buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
                };
              },
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff: async () => ({
                manifest,
                fidelity: "processes" as const,
                released: ["pty-1"],
                skipped: [],
              }),
              completeHandoff: async () => {
                await socket.close();
                return { stopping: true as const };
              },
              adoptRegistry: async () => {
                throw stationHostSafeError(
                  "HOST_HANDOFF_MANIFEST_INVALID",
                  "control socket missing",
                );
              },
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_HANDOFF_MANIFEST_INVALID" },
      });
      expect(spawnHost).toHaveBeenCalledOnce();
    } finally {
      await socket.close();
    }
  });

  it("opt-in handoff preserves the original refusal when beginHandoff fails", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const abortHandoff = vi.fn(async () => ({ adopted: [], failed: [] }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff: async () => {
                throw stationHostSafeError(
                  "HOST_HANDOFF_INVALID_STATE",
                  "The host is already draining or handing off.",
                );
              },
              abortHandoff,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: {
          code: "HOST_UPGRADE_BLOCKED",
          message: "Host build older-build owns 1 live terminal.",
          hint: expect.stringContaining(
            "The host is already draining or handing off. (HOST_HANDOFF_INVALID_STATE)",
          ),
        },
      });
      expect(abortHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("opt-in handoff begins, completes, spawns successor, and adopts the manifest", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const manifest = {
      "pty-1": {
        bridgeProtocolVersion: 2 as const,
        bridgePid: 4242,
        controlSocket: "/tmp/pty-1.sock",
        command: "/bin/sh",
        cols: 80,
        rows: 24,
        ptyInstanceId: "instance-pty-1",
        identity: {
          kind: "agent" as const,
          terminalTargetId: "native:wt-1",
          worktreeId: "wt-1",
          projectId: "proj-1",
          sessionId: "ses-1",
          worktreePath: "/repo/wt-1",
          harnessProvider: "claude",
        },
      },
    };
    const beginHandoff = vi.fn(async () => ({
      manifest,
      fidelity: "processes" as const,
      released: ["pty-1"],
      skipped: [],
    }));
    const completeHandoff = vi.fn(async () => {
      await socket.close();
      return { stopping: true as const };
    });
    const adoptRegistry = vi.fn(async () => ({ adopted: ["pty-1"], failed: [] }));
    let healthCalls = 0;
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => {
                healthCalls += 1;
                return {
                  ok: true,
                  protocolVersion: HOST_PROTOCOL_VERSION,
                  buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
                };
              },
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 1 live terminal.",
                );
              },
              beginHandoff,
              completeHandoff,
              adoptRegistry,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "running",
        socketPath,
        ensuredBy: "handoff",
        handoffAdopt: {
          adopted: ["pty-1"],
          failed: [],
          fidelity: "processes",
          receipt: {
            terminals: [
              {
                terminalTargetId: "native:wt-1",
                ptyId: "pty-1",
                ptyInstanceId: "instance-pty-1",
              },
            ],
          },
        },
      });
      expect(beginHandoff).toHaveBeenCalledWith(expectedBuildVersion, "processes");
      expect(completeHandoff).toHaveBeenCalledOnce();
      expect(spawnHost).toHaveBeenCalledOnce();
      expect(adoptRegistry).toHaveBeenCalledWith(manifest);
    } finally {
      await socket.close();
    }
  });

  it("opt-in handoff refuses when adopt reports any failed entry", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const manifest = {
      "pty-1": {
        bridgeProtocolVersion: 2 as const,
        bridgePid: 4242,
        controlSocket: "/tmp/pty-1.sock",
        command: "/bin/sh",
        cols: 80,
        rows: 24,
        ptyInstanceId: "instance-pty-1",
        identity: {
          kind: "agent" as const,
          terminalTargetId: "native:wt-1",
          worktreeId: "wt-1",
          projectId: "proj-1",
          sessionId: "ses-1",
          worktreePath: "/repo/wt-1",
          harnessProvider: "claude",
        },
      },
      "pty-2": {
        bridgeProtocolVersion: 2 as const,
        bridgePid: 4243,
        controlSocket: "/tmp/pty-2.sock",
        command: "/bin/sh",
        cols: 80,
        rows: 24,
        ptyInstanceId: "instance-pty-2",
        identity: {
          kind: "agent" as const,
          terminalTargetId: "native:wt-2",
          worktreeId: "wt-2",
          projectId: "proj-1",
          sessionId: "ses-2",
          worktreePath: "/repo/wt-2",
          harnessProvider: "claude",
        },
      },
    };
    let healthCalls = 0;
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          handoff: { fidelity: "processes" },
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => {
                healthCalls += 1;
                return {
                  ok: true,
                  protocolVersion: HOST_PROTOCOL_VERSION,
                  buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
                };
              },
              stopIfIdle: async () => {
                throw stationHostSafeError(
                  "HOST_UPGRADE_BLOCKED",
                  "Host build older-build owns 2 live terminals.",
                );
              },
              beginHandoff: async () => ({
                manifest,
                fidelity: "processes" as const,
                released: ["pty-1", "pty-2"],
                skipped: [],
              }),
              completeHandoff: async () => {
                await socket.close();
                return { stopping: true as const };
              },
              adoptRegistry: async () => ({
                adopted: ["pty-1"],
                failed: [{ ptyId: "pty-2", reason: "adopt-failed" }],
              }),
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_HANDOFF_MANIFEST_INVALID" },
      });
      expect(spawnHost).toHaveBeenCalledOnce();
    } finally {
      await socket.close();
    }
  });

  it("does not stop a different-build host when no replacement command is configured", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const stopIfIdle = vi.fn(async () => ({ stopping: true as const }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: [""],
          expectedBuildVersion,
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("does not spawn or unlink when an idle host never releases its socket", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const stopIfIdle = vi.fn(async () => ({ stopping: true as const }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
          timeoutMs: 120,
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      expect(stopIfIdle).toHaveBeenCalledTimes(1);
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("refuses legacy health without lifecycle calls, replacement, or socket removal", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const stopIfIdle = vi.fn(async () => ({ stopping: true as const }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({ ok: true, protocolVersion: HOST_PROTOCOL_VERSION }),
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("refuses a protocol mismatch without sending the new lifecycle method", async () => {
    const socket = await liveSocket();
    const { socketPath } = socket;
    const stopIfIdle = vi.fn(async () => ({ stopping: true as const }));
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          expectedBuildVersion,
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION - 1,
                buildVersion: "older-build",
              }),
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_VERSION_INCOMPATIBLE" },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
    } finally {
      await socket.close();
    }
  });

  it("refuses idle replacement when a PTY appears after exact inspection without falling back", async () => {
    const socket = await liveSocket();
    const stopIfIdle = vi.fn(async () => {
      throw stationHostSafeError("HOST_UPGRADE_BLOCKED", "A terminal appeared.");
    });
    const beginHandoff = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("replace-idle", []),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              recoveryInventory: async () => ({
                buildIdentity: incumbentBuildIdentity,
                ptys: [],
              }),
              stopIfIdle,
              beginHandoff,
            }),
          spawnHost,
        },
      );

      expect(result).toMatchObject({
        status: "stale",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(stopIfIdle).toHaveBeenCalledOnce();
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("refuses live handoff when the planned busy inventory became idle without replacing", async () => {
    const socket = await liveSocket();
    const manifest = oneEntryHandoffManifest("pty-1");
    const beginHandoff = vi.fn();
    const stopIfIdle = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("handoff", terminalIdentities(manifest)),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              recoveryInventory: async () => ({
                buildIdentity: incumbentBuildIdentity,
                ptys: [],
              }),
              beginHandoff,
              stopIfIdle,
            }),
          spawnHost,
        },
      );

      expect(result).toMatchObject({
        status: "stale",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("refuses a same-count wrong immutable inventory before live handoff", async () => {
    const socket = await liveSocket();
    const expectedManifest = oneEntryHandoffManifest("pty-1");
    const wrongManifest = oneEntryHandoffManifest("pty-2");
    const beginHandoff = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("handoff", terminalIdentities(expectedManifest)),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              recoveryInventory: async () => ({
                buildIdentity: incumbentBuildIdentity,
                ptys: recoveryPtys(wrongManifest),
              }),
              beginHandoff,
            }),
        },
      );

      expect(result).toMatchObject({
        status: "stale",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(beginHandoff).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("executes an exact idle replacement without entering live handoff", async () => {
    const socket = await liveSocket();
    let healthCalls = 0;
    let inventoryCalls = 0;
    const stopIfIdle = vi.fn(async () => {
      await socket.close();
      return { stopping: true as const };
    });
    const beginHandoff = vi.fn();
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    const result = await convergeStationHostForUpdate(
      {
        socketPath: socket.socketPath,
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        command: convergenceCommand("replace-idle", []),
      },
      {
        clientFactory: () =>
          fakeClient({
            health: async () => {
              healthCalls += 1;
              return {
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
              };
            },
            recoveryInventory: async () => {
              inventoryCalls += 1;
              return {
                buildIdentity: inventoryCalls === 1 ? incumbentBuildIdentity : targetBuildIdentity,
                ptys: [],
              };
            },
            stopIfIdle,
            beginHandoff,
          }),
        spawnHost,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      receipt: { ensuredBy: "idle-replace", actualInventory: { terminals: [] } },
    });
    expect(stopIfIdle).toHaveBeenCalledOnce();
    expect(beginHandoff).not.toHaveBeenCalled();
    expect(spawnHost).toHaveBeenCalledOnce();
  });

  it("executes an exact busy handoff without attempting idle replacement", async () => {
    const socket = await liveSocket();
    const manifest = oneEntryHandoffManifest("pty-1");
    let healthCalls = 0;
    let inventoryCalls = 0;
    const stopIfIdle = vi.fn();
    const beginHandoff = vi.fn(async () => ({
      manifest,
      fidelity: "processes" as const,
      released: ["pty-1"],
      skipped: [],
    }));
    const completeHandoff = vi.fn(async () => {
      await socket.close();
      return { stopping: true as const };
    });
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput): ChildProcessLike => ({ pid: 999, unref: () => undefined }),
    );
    const result = await convergeStationHostForUpdate(
      {
        socketPath: socket.socketPath,
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        command: convergenceCommand("handoff", terminalIdentities(manifest)),
      },
      {
        clientFactory: () =>
          fakeClient({
            health: async () => {
              healthCalls += 1;
              return {
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: healthCalls === 1 ? "older-build" : expectedBuildVersion,
              };
            },
            recoveryInventory: async () => {
              inventoryCalls += 1;
              return {
                buildIdentity: inventoryCalls === 1 ? incumbentBuildIdentity : targetBuildIdentity,
                ptys: recoveryPtys(manifest),
              };
            },
            stopIfIdle,
            beginHandoff,
            completeHandoff,
            adoptRegistry: async () => ({ adopted: ["pty-1"], failed: [] }),
          }),
        spawnHost,
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      receipt: {
        ensuredBy: "handoff",
        fidelity: "processes",
        handoffReceipt: { terminals: terminalIdentities(manifest) },
      },
    });
    expect(stopIfIdle).not.toHaveBeenCalled();
    expect(beginHandoff).toHaveBeenCalledOnce();
    expect(spawnHost).toHaveBeenCalledOnce();
  });

  it("refuses and restores a live handoff when the Host acknowledges another fidelity", async () => {
    const socket = await liveSocket();
    const manifest = oneEntryHandoffManifest("pty-1");
    const abortHandoff = vi.fn(async () => ({ adopted: ["pty-1"], failed: [] }));
    const completeHandoff = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("handoff", terminalIdentities(manifest)),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "older-build",
              }),
              recoveryInventory: async () => ({
                buildIdentity: incumbentBuildIdentity,
                ptys: recoveryPtys(manifest),
              }),
              beginHandoff: async () => ({
                manifest,
                fidelity: "screen",
                released: ["pty-1"],
                skipped: [],
              }),
              abortHandoff,
              completeHandoff,
            }),
          spawnHost,
        },
      );

      expect(result).toMatchObject({
        requestedAction: "handoff",
        requestedFidelity: "processes",
        status: "stale",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(abortHandoff).toHaveBeenCalledOnce();
      expect(completeHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("returns absent without starting a Host when the planned incumbent disappeared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-host-update-absent-"));
    const clientFactory = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: join(directory, "host.sock"),
          stateDir: directory,
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("replace-idle", []),
        },
        { clientFactory, spawnHost },
      );

      expect(result).toMatchObject({
        status: "absent",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(clientFactory).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns already-converged without mutation for the exact target and inventory", async () => {
    const socket = await liveSocket();
    const manifest = oneEntryHandoffManifest("pty-1");
    const stopIfIdle = vi.fn();
    const beginHandoff = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("handoff", terminalIdentities(manifest)),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: expectedBuildVersion,
              }),
              recoveryInventory: async () => ({
                buildIdentity: targetBuildIdentity,
                ptys: recoveryPtys(manifest),
              }),
              stopIfIdle,
              beginHandoff,
            }),
          spawnHost,
        },
      );

      expect(result).toMatchObject({
        status: "already-converged",
        actualInventory: { terminals: terminalIdentities(manifest) },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("returns stale without mutation when a different incumbent replaced the planned Host", async () => {
    const socket = await liveSocket();
    const stopIfIdle = vi.fn();
    const beginHandoff = vi.fn();
    const spawnHost = vi.fn();
    try {
      const result = await convergeStationHostForUpdate(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["bun", "/tmp/hostMain.ts"],
          command: convergenceCommand("replace-idle", []),
        },
        {
          clientFactory: () =>
            fakeClient({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "other-incumbent-build",
              }),
              recoveryInventory: async () => ({
                buildIdentity: "c".repeat(64),
                ptys: [],
              }),
              stopIfIdle,
              beginHandoff,
            }),
          spawnHost,
        },
      );

      expect(result).toMatchObject({
        status: "stale",
        error: { code: "HOST_CONVERGENCE_PLAN_DRIFT" },
      });
      expect(stopIfIdle).not.toHaveBeenCalled();
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });
});
