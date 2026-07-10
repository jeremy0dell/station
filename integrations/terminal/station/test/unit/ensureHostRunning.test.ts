import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationHostClient } from "@station/host";
import {
  type ChildProcessLike,
  ensureStationHostRunning,
  type SpawnStationHostInput,
} from "@station/terminal";
import { describe, expect, it, vi } from "vitest";

function fakeClient(overrides: Partial<StationHostClient> = {}): StationHostClient {
  return {
    health: async () => ({ ok: true, protocolVersion: 1 }),
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

describe("ensureStationHostRunning", () => {
  it("reports unavailable when no host entry is configured", async () => {
    const handle = await ensureStationHostRunning(
      { socketPath: absentSocketPath(), stateDir: tmpdir(), hostCommand: [""] },
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
});
