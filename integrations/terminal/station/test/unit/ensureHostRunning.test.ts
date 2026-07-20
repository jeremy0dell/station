import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_PROTOCOL_VERSION, type StationHostClient, stationHostSafeError } from "@station/host";
import { listenUnixSocket, probeUnixSocket } from "@station/protocol";
import {
  type ChildProcessLike,
  ensureStationHostRunning,
  type SpawnStationHostInput,
} from "@station/terminal";
import { describe, expect, it, vi } from "vitest";

const expectedBuildVersion = "test-build";

function fakeClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      buildVersion: expectedBuildVersion,
    }),
    stopIfIdle: async () => ({ stopping: true }),
    spawn: async () => ({ ptyId: "p", pid: 1 }),
    write: async () => undefined,
    resize: async () => undefined,
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
    expect(handle.status).toBe("running");
    expect(spawnHost).toHaveBeenCalledTimes(1);
    expect(spawnHost.mock.calls[0]?.[0]).toEqual({
      argv: ["bun", "/tmp/hostMain.ts", "--socket", expect.any(String), "--state-dir", tmpdir()],
      spawnOptions: { detached: true, stdio: "ignore" },
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

      expect(handle).toMatchObject({ status: "running", socketPath, client });
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
    const stopIfIdle = vi.fn(async () => {
      throw stationHostSafeError(
        "HOST_UPGRADE_BLOCKED",
        "Host build older-build owns 2 live terminals; requested build is test-build.",
      );
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
      expect(spawnHost).not.toHaveBeenCalled();
      await expect(probeUnixSocket(socketPath)).resolves.toMatchObject({ status: "listening" });
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
});
