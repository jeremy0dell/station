import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_PROTOCOL_VERSION,
  StationHostProviderError,
  type HostListEntry,
} from "@station/host";
import { listLiveHostPtys } from "../listLiveHostPtys.js";

const EXPECTED_BUILD_VERSION = "build-current";

function tempSocketPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "list-host-"));
  const path = join(dir, "station-host.sock");
  writeFileSync(path, "");
  return { dir, path };
}

function entry(): HostListEntry {
  return {
    kind: "aux",
    ptyId: "pty-1",
    ptyInstanceId: "instance-1",
    terminalTargetId: "aux:pane-split-0",
    worktreeId: "aux",
    projectId: "aux",
    sessionId: "aux",
    worktreePath: "/work",
    harnessProvider: "aux",
    pid: 1,
    alive: true,
    cols: 80,
    rows: 24,
  };
}

describe("listLiveHostPtys", () => {
  it("returns undefined when the socket file is absent (boot stays cold)", async () => {
    let handedOff = false;
    expect(
      await listLiveHostPtys("/no/such/station-host.sock", {
        env: { STATION_HOST_HANDOFF: "1" },
        handoffBusyHost: async () => {
          handedOff = true;
          return [];
        },
      }),
    ).toBeUndefined();
    expect(handedOff).toBe(false);
  });

  it("reuses a same-build host, returns its live entries, and disposes the client", async () => {
    const { dir, path } = tempSocketPath();
    try {
      const entries = [entry()];
      let disposed = false;
      let handedOff = false;
      const result = await listLiveHostPtys(path, {
        env: { STATION_HOST_HANDOFF: "1" },
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: EXPECTED_BUILD_VERSION,
          }),
          list: async () => entries,
          stopIfIdle: async () => ({ stopping: true }),
          dispose: () => (disposed = true),
        }),
        handoffBusyHost: async () => {
          handedOff = true;
          return [];
        },
      });
      expect(result).toBe(entries);
      expect(disposed).toBe(true);
      expect(handedOff).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined (and disposes) when list never resolves within the timeout", async () => {
    const { dir, path } = tempSocketPath();
    try {
      let disposed = false;
      const result = await listLiveHostPtys(path, {
        timeoutMs: 20,
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: EXPECTED_BUILD_VERSION,
          }),
          list: () => new Promise<readonly HostListEntry[]>(() => {}),
          stopIfIdle: async () => ({ stopping: true }),
          dispose: () => (disposed = true),
        }),
      });
      expect(result).toBeUndefined();
      expect(disposed).toBe(true); // dispose() also cancels the in-flight list
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when list rejects, without an unhandled rejection", async () => {
    const { dir, path } = tempSocketPath();
    try {
      const result = await listLiveHostPtys(path, {
        timeoutMs: 1000,
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: EXPECTED_BUILD_VERSION,
          }),
          list: async () => {
            throw new Error("host blew up");
          },
          stopIfIdle: async () => ({ stopping: true }),
          dispose: () => {},
        }),
      });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("observes a list rejection that arrives after the timeout", async () => {
    const { dir, path } = tempSocketPath();
    try {
      let rejectList: ((error: Error) => void) | undefined;
      const result = await listLiveHostPtys(path, {
        timeoutMs: 5,
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: EXPECTED_BUILD_VERSION,
          }),
          list: () =>
            new Promise<readonly HostListEntry[]>((_, reject) => {
              rejectList = reject;
            }),
          stopIfIdle: async () => ({ stopping: true }),
          dispose: () => {},
        }),
      });

      expect(result).toBeUndefined();
      rejectList?.(new Error("late host failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops an idle host from a different build and keeps boot cold", async () => {
    const { dir, path } = tempSocketPath();
    try {
      const stopRequests: string[] = [];
      let listed = false;
      const result = await listLiveHostPtys(path, {
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: "build-old",
          }),
          list: async () => {
            listed = true;
            return [];
          },
          stopIfIdle: async (requestingBuildVersion) => {
            stopRequests.push(requestingBuildVersion);
            return { stopping: true };
          },
          dispose: () => {},
        }),
      });

      expect(result).toBeUndefined();
      expect(stopRequests).toEqual([EXPECTED_BUILD_VERSION]);
      expect(listed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a live-PTY upgrade refusal instead of treating the host as absent", async () => {
    const { dir, path } = tempSocketPath();
    try {
      await expect(
        listLiveHostPtys(path, {
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "build-old",
            }),
            list: async () => [],
            stopIfIdle: async () => {
              throw new StationHostProviderError(
                "HOST_UPGRADE_BLOCKED",
                "Cannot upgrade while a live terminal is hosted.",
              );
            },
            dispose: () => {},
          }),
        }),
      ).rejects.toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const gate of [undefined, "", "true", "0", "yes"]) {
    it(`preserves the exact busy-host refusal when the handoff gate is ${String(gate)}`, async () => {
      const { dir, path } = tempSocketPath();
      const refusal = new StationHostProviderError(
        "HOST_UPGRADE_BLOCKED",
        "Cannot upgrade while a live terminal is hosted.",
        { hint: "Original refusal hint." },
      );
      let handedOff = false;
      try {
        let caught: unknown;
        try {
          await listLiveHostPtys(path, {
            env: { STATION_HOST_HANDOFF: gate },
            expectedBuildVersion: EXPECTED_BUILD_VERSION,
            createClient: () => ({
              health: async () => ({
                ok: true,
                protocolVersion: HOST_PROTOCOL_VERSION,
                buildVersion: "build-old",
              }),
              list: async () => [],
              stopIfIdle: async () => {
                throw refusal;
              },
              dispose: () => {},
            }),
            handoffBusyHost: async () => {
              handedOff = true;
              return [];
            },
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(refusal);
        expect(handedOff).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("hands off only after a gated busy replacement and returns successor inventory", async () => {
    const { dir, path } = tempSocketPath();
    let disposed = false;
    let listedIncumbent = false;
    const successor = [entry()];
    try {
      const result = await listLiveHostPtys(path, {
        env: { STATION_HOST_HANDOFF: "1" },
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: "build-old",
          }),
          list: async () => {
            listedIncumbent = true;
            return [];
          },
          stopIfIdle: async () => {
            throw new StationHostProviderError(
              "HOST_UPGRADE_BLOCKED",
              "Cannot upgrade while a live terminal is hosted.",
            );
          },
          dispose: () => (disposed = true),
        }),
        handoffBusyHost: async (input) => {
          expect(disposed).toBe(true);
          expect(input).toEqual({
            socketPath: path,
            expectedBuildVersion: EXPECTED_BUILD_VERSION,
          });
          return successor;
        },
      });

      expect(result).toBe(successor);
      expect(listedIncumbent).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates gated handoff failure instead of treating the successor as absent", async () => {
    const { dir, path } = tempSocketPath();
    try {
      await expect(
        listLiveHostPtys(path, {
          env: { STATION_HOST_HANDOFF: "1" },
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "build-old",
            }),
            list: async () => [],
            stopIfIdle: async () => {
              throw new StationHostProviderError(
                "HOST_UPGRADE_BLOCKED",
                "Cannot upgrade while a live terminal is hosted.",
              );
            },
            dispose: () => {},
          }),
          handoffBusyHost: async () => {
            throw new StationHostProviderError(
              "HOST_HANDOFF_MANIFEST_INVALID",
              "Successor inventory failed.",
            );
          },
        }),
      ).rejects.toMatchObject({
        code: "HOST_HANDOFF_MANIFEST_INVALID",
        message: "Successor inventory failed.",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails safely when an incompatible host does not confirm idle shutdown", async () => {
    const { dir, path } = tempSocketPath();
    try {
      await expect(
        listLiveHostPtys(path, {
          timeoutMs: 20,
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "build-old",
            }),
            list: async () => [],
            stopIfIdle: () => new Promise<{ stopping: true }>(() => {}),
            dispose: () => {},
          }),
        }),
      ).rejects.toMatchObject({ code: "HOST_VERSION_INCOMPATIBLE" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates protocol incompatibility instead of cold-restoring", async () => {
    const { dir, path } = tempSocketPath();
    try {
      await expect(
        listLiveHostPtys(path, {
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION - 1,
              buildVersion: "build-old",
            }),
            list: async () => {
              throw new StationHostProviderError(
                "HOST_VERSION_INCOMPATIBLE",
                "Station host protocol is incompatible.",
              );
            },
            stopIfIdle: async () => ({ stopping: true }),
            dispose: () => {},
          }),
        }),
      ).rejects.toMatchObject({ code: "HOST_VERSION_INCOMPATIBLE" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
