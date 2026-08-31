import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_PROTOCOL_VERSION } from "@station/contracts";
import {
  type StationHostClient,
  type StationHostLifecycleSession,
  stationHostSafeError,
} from "@station/host";
import { listenUnixSocket, probeUnixSocket } from "@station/protocol";
import {
  type ChildProcessLike,
  ensureStationHostRunning,
  type SpawnStationHostInput,
} from "@station/terminal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCausalStationHost } from "../../src/host/readStationHostEvidence.js";
import {
  createListeningStationHostFixture,
  listeningStationHostCommand,
} from "../support/listeningStationHostFixture.js";

const expectedBuildVersion = "test-build";

class FakeChild extends EventEmitter {
  pid: number | undefined;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  constructor(
    pid = 42,
    private readonly settleOnSignal = true,
  ) {
    super();
    this.pid = pid;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.settleOnSignal) this.emit("exit", 0, signal ?? null);
    return true;
  }
  unref(): this {
    return this;
  }
}

function fakeClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: expectedBuildVersion,
    }),
    stopIfIdle: async () => ({ stopping: true }),
    beginHandoff: async () => ({ manifest: {}, fidelity: "processes", released: [], skipped: [] }),
    completeHandoff: async () => ({ stopping: true }),
    abortHandoff: async () => ({ adopted: [], failed: [] }),
    adoptRegistry: async () => ({ adopted: [], failed: [] }),
    spawn: async () => ({
      terminalTargetId: "native:p",
      ptyId: "p",
      ptyInstanceId: "instance-p",
      pid: 1,
    }),
    list: async () => [],
    recoveryInventory: async () => ({ buildIdentity: "a".repeat(64), ptys: [] }),
    focus: async () => undefined,
    close: async () => ({ closed: true }),
    attach: async () => {
      throw new Error("not used");
    },
    dispose: () => undefined,
    ...overrides,
  };
}

function lifecycleSession(
  buildVersion = expectedBuildVersion,
  overrides: Partial<StationHostLifecycleSession> = {},
): StationHostLifecycleSession {
  return {
    health: vi.fn(async () => ({ ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion })),
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
    ...overrides,
  };
}

function absentSocketPath(): string {
  return join(
    tmpdir(),
    `station-host-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  );
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

function readyEvidence(socketPath: string, pid = 42, buildVersion = expectedBuildVersion) {
  const endpoint = { socketPath, ino: 11n, birthtimeNs: 22n };
  const session = lifecycleSession(buildVersion);
  const sequence: string[] = [];
  return {
    endpoint,
    session,
    sequence,
    readiness: {
      now: () => 1_000,
      probeEndpoint: vi.fn(async () => {
        sequence.push(sequence.length === 0 ? "E0" : "E1");
        return { status: "listening" as const, endpoint };
      }),
      openSession: vi.fn(async (input) => {
        sequence.push("open");
        expect(input.deadlineMs).toBe(11_000);
        return session;
      }),
      readHolders: vi.fn(async (_path, deadlineMs) => {
        sequence.push("holder");
        expect(deadlineMs).toBe(11_000);
        return [pid];
      }),
    },
  };
}

describe("ensureStationHostRunning compatibility policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports unavailable when no Host entry is configured", async () => {
    const handle = await ensureStationHostRunning(
      {
        socketPath: absentSocketPath(),
        stateDir: tmpdir(),
        hostCommand: [""],
        expectedBuildVersion,
      },
      { clientFactory: () => fakeClient() },
    );
    expect(handle).toMatchObject({ status: "unavailable", error: { code: "HOST_UNREACHABLE" } });
  });

  it("cold-starts only after causal readiness, then returns the shared client", async () => {
    const socketPath = absentSocketPath();
    const ready = readyEvidence(socketPath);
    const shared = fakeClient();
    const child = new FakeChild();
    const spawnHost = vi.fn(
      (_input: SpawnStationHostInput) => child as unknown as ChildProcessLike,
    );
    const handle = await ensureStationHostRunning(
      {
        socketPath,
        stateDir: tmpdir(),
        hostCommand: ["bun", "/tmp/hostMain.ts"],
        expectedBuildVersion,
      },
      {
        clientFactory: () => shared,
        spawnHost,
        readiness: ready.readiness,
        now: () => 1_000,
      },
    );

    expect(handle).toEqual({ status: "running", socketPath, client: shared, ensuredBy: "start" });
    expect(spawnHost).toHaveBeenCalledWith({
      argv: ["bun", "/tmp/hostMain.ts", "--socket", socketPath, "--state-dir", tmpdir()],
      spawnOptions: { detached: true, stdio: "ignore" },
    });
    expect(ready.sequence).toEqual(["E0", "open", "holder", "E1"]);
    expect(ready.session.health).toHaveBeenCalledTimes(2);
    expect(ready.session.dispose).toHaveBeenCalledOnce();
    expect(child.signals).toEqual([]);
  });

  it("admits a real listening direct child only through canonical holder evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "station-host-causal-fixture-"));
    const socketPath = join(directory, "host.sock");
    const fixture = createListeningStationHostFixture();
    const session = lifecycleSession();
    try {
      await expect(
        ensureStationHostRunning(
          {
            socketPath,
            stateDir: directory,
            hostCommand: listeningStationHostCommand(),
            expectedBuildVersion,
            timeoutMs: 2_000,
          },
          {
            clientFactory: () => fakeClient(),
            spawnHost: fixture.spawnHost,
            readiness: { openSession: async () => session },
          },
        ),
      ).resolves.toMatchObject({ status: "running", ensuredBy: "start" });
      expect(session.health).toHaveBeenCalledTimes(2);
      expect(session.dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("snapshots command, environment selection, callbacks, and options before awaiting", async () => {
    vi.stubEnv("STATION_RUNTIME_OWNER_FOREGROUND", "1");
    const socketPath = absentSocketPath();
    const ready = readyEvidence(socketPath);
    const readiness = { ...ready.readiness };
    const hostCommand = ["bun", "/tmp/original.ts"] as [string, string];
    const child = new FakeChild();
    const spawnHost = vi.fn(() => child as unknown as ChildProcessLike);
    const pending = ensureStationHostRunning(
      { socketPath, stateDir: "/original-state", hostCommand, expectedBuildVersion },
      {
        clientFactory: () => fakeClient(),
        spawnHost,
        readiness,
        now: () => 1_000,
      },
    );
    hostCommand[0] = "mutated";
    readiness.probeEndpoint = async () => {
      throw new Error("mutated callback must not run");
    };
    vi.unstubAllEnvs();

    await expect(pending).resolves.toMatchObject({ status: "running" });
    expect(spawnHost).toHaveBeenCalledWith({
      argv: ["bun", "/tmp/original.ts", "--socket", socketPath, "--state-dir", "/original-state"],
      spawnOptions: { detached: false, stdio: "ignore" },
    });
  });

  it("signals only the retained direct child when readiness fails", async () => {
    const socketPath = absentSocketPath();
    const child = new FakeChild();
    const handle = await ensureStationHostRunning(
      {
        socketPath,
        stateDir: tmpdir(),
        hostCommand: ["station-host"],
        expectedBuildVersion,
      },
      {
        clientFactory: () => fakeClient(),
        spawnHost: () => child as unknown as ChildProcessLike,
        readiness: {
          now: () => 1_000,
          probeEndpoint: async () => {
            throw new Error("evidence unavailable");
          },
        },
        now: () => 1_000,
      },
    );
    expect(handle).toMatchObject({ status: "unavailable" });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("reuses display compatibility without exact identity inspection", async () => {
    const socket = await liveSocket();
    const recoveryInventory = vi.fn();
    const spawnHost = vi.fn();
    const client = fakeClient({ recoveryInventory });
    try {
      await expect(
        ensureStationHostRunning(
          {
            socketPath: socket.socketPath,
            stateDir: tmpdir(),
            hostCommand: ["station-host"],
            expectedBuildVersion,
          },
          { clientFactory: () => client, spawnHost },
        ),
      ).resolves.toEqual({
        status: "running",
        socketPath: socket.socketPath,
        client,
        ensuredBy: "reuse",
      });
      expect(recoveryInventory).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("atomically replaces an idle incompatible display build", async () => {
    const socket = await liveSocket();
    const ready = readyEvidence(socket.socketPath);
    const stopIfIdle = vi.fn(async () => {
      await socket.close();
      return { stopping: true as const };
    });
    const client = fakeClient({
      health: async () => ({
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: "older-build",
      }),
      stopIfIdle,
    });
    const child = new FakeChild();
    const handle = await ensureStationHostRunning(
      {
        socketPath: socket.socketPath,
        stateDir: tmpdir(),
        hostCommand: ["station-host"],
        expectedBuildVersion,
      },
      {
        clientFactory: () => client,
        spawnHost: () => child as unknown as ChildProcessLike,
        readiness: ready.readiness,
        now: () => 1_000,
      },
    );
    expect(handle).toMatchObject({ status: "running", ensuredBy: "idle-replace" });
    expect(stopIfIdle).toHaveBeenCalledWith(expectedBuildVersion);
    expect(child.signals).toEqual([]);
  });

  it("preserves a busy incompatible Host and never begins handoff or spawns", async () => {
    const socket = await liveSocket();
    const refusal = stationHostSafeError("HOST_UPGRADE_BLOCKED", "one live terminal");
    const stopIfIdle = vi.fn(async () => {
      throw refusal;
    });
    const beginHandoff = vi.fn();
    const spawnHost = vi.fn();
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["station-host"],
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
              beginHandoff,
            }),
          spawnHost,
        },
      );
      expect(handle).toMatchObject({ status: "unavailable", error: refusal });
      expect(beginHandoff).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socket.socketPath)).resolves.toMatchObject({
        status: "listening",
      });
    } finally {
      await socket.close();
    }
  });

  it("refuses a protocol mismatch without lifecycle mutation", async () => {
    const socket = await liveSocket();
    const stopIfIdle = vi.fn();
    const spawnHost = vi.fn();
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["station-host"],
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
    } finally {
      await socket.close();
    }
  });

  it("does not stop an incompatible Host without a replacement command", async () => {
    const socket = await liveSocket();
    const stopIfIdle = vi.fn();
    try {
      const handle = await ensureStationHostRunning(
        {
          socketPath: socket.socketPath,
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
        },
      );
      expect(handle).toMatchObject({ status: "unavailable" });
      expect(stopIfIdle).not.toHaveBeenCalled();
    } finally {
      await socket.close();
    }
  });

  it("preserves inaccessible ownership without health, spawn, or unlink", async () => {
    const socket = await liveSocket();
    const before = await lstat(socket.socketPath, { bigint: true });
    const clientFactory = vi.fn();
    const spawnHost = vi.fn();
    try {
      await chmod(socket.socketPath, 0o000);
      const handle = await ensureStationHostRunning(
        {
          socketPath: socket.socketPath,
          stateDir: tmpdir(),
          hostCommand: ["station-host"],
          expectedBuildVersion,
        },
        { clientFactory, spawnHost },
      );
      expect(handle).toMatchObject({
        status: "unavailable",
        error: { code: "HOST_UNREACHABLE", hint: expect.stringContaining("do not unlink") },
      });
      const after = await lstat(socket.socketPath, { bigint: true });
      expect({ ino: after.ino, birthtimeNs: after.birthtimeNs }).toEqual({
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
      });
      expect(clientFactory).not.toHaveBeenCalled();
      expect(spawnHost).not.toHaveBeenCalled();
    } finally {
      await chmod(socket.socketPath, 0o600);
      await socket.close();
    }
  });
});

describe("causal Host startup readiness", () => {
  it.each([
    "endpoint",
    "health",
    "holder",
  ] as const)("fails and settles the child on %s substitution", async (substitution) => {
    const socketPath = absentSocketPath();
    const endpoint = { socketPath, ino: 1n, birthtimeNs: 2n };
    const child = new FakeChild();
    const session = lifecycleSession(
      expectedBuildVersion,
      substitution === "health"
        ? {
            health: vi
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
              }),
          }
        : {},
    );
    let probes = 0;
    const result = await startCausalStationHost(
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
