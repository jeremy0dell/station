import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostListEntry } from "@station/host";
import { listLiveHostPtys } from "./listLiveHostPtys.js";

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
    expect(await listLiveHostPtys("/no/such/station-host.sock")).toBeUndefined();
  });

  it("returns the live entries when list resolves, and disposes the client", async () => {
    const { dir, path } = tempSocketPath();
    try {
      const entries = [entry()];
      let disposed = false;
      const result = await listLiveHostPtys(path, {
        createClient: () => ({ list: async () => entries, dispose: () => (disposed = true) }),
      });
      expect(result).toBe(entries);
      expect(disposed).toBe(true);
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
        createClient: () => ({
          list: () => new Promise<readonly HostListEntry[]>(() => {}),
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
        createClient: () => ({
          list: async () => {
            throw new Error("host blew up");
          },
          dispose: () => {},
        }),
      });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
