import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAttachment, HostFrame, StationHostClient } from "@station/host";
import { resolveAuxShellPlacement } from "./auxShellPlacement.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tempSocketPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aux-host-"));
  const path = join(dir, "station-host.sock");
  // A plain file satisfies the existsSync gate; the injected client avoids any
  // real socket connect.
  writeFileSync(path, "");
  return { dir, path };
}

function fakeClient(spawns: unknown[]): StationHostClient {
  const pendingFrames: AsyncIterable<HostFrame> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HostFrame>>(() => {}) }),
  };
  const attachment: HostAttachment = {
    ack: { subscribed: true, ptyId: "pty-1", pid: 1, cols: 80, rows: 24, exited: false, scrollback: [], truncated: false },
    frames: pendingFrames,
    write: async () => undefined,
    resize: async () => undefined,
    detach: async () => undefined,
  };
  return {
    spawn: async (params) => {
      spawns.push(params);
      return { ptyId: "pty-1", pid: 1 };
    },
    attach: async () => attachment,
    dispose: () => undefined,
    health: async () => ({ ok: true, protocolVersion: 1 }),
    stopIfIdle: async () => ({ stopping: true }),
    write: async () => undefined,
    resize: async () => undefined,
    list: async () => [],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
  } satisfies StationHostClient;
}

describe("resolveAuxShellPlacement", () => {
  it("returns undefined for a pane when no host socket is present (→ local shell)", () => {
    const placeShell = resolveAuxShellPlacement("/no/such/station-host.sock");
    expect(placeShell("pane-split-0")).toBeUndefined();
  });

  it("spawns a kind:'aux' PTY with the derived target id and the laid-out cwd/size", async () => {
      const { dir, path } = tempSocketPath();
    try {
      const spawns: unknown[] = [];
      const placeShell = resolveAuxShellPlacement(path, () => fakeClient(spawns));
      const createTerminal = placeShell("pane-split-0");
      if (createTerminal === undefined) {
        throw new Error("Expected the host-backed aux terminal factory.");
      }

      const terminal = createTerminal({
        cwd: "/work/sub",
        env: { TERM: "xterm-kitty", GHOSTTY_RESOURCES_DIR: "/ghostty" },
        size: { cols: 120, rows: 40 },
      });
      await flush();

      expect(spawns).toHaveLength(1);
      const params = spawns[0] as {
        kind: string;
        terminalTargetId: string;
        cwd: string;
        cols: number;
        rows: number;
        env?: Record<string, string>;
      };
      expect(params.kind).toBe("aux");
      // Derived from the pane id, so a later boot recomputes the same key.
      expect(params.terminalTargetId).toBe("aux:pane-split-0");
      expect(params.cwd).toBe("/work/sub");
      expect(params.cols).toBe(120);
      expect(params.rows).toBe(40);
      expect(params.env).toBeUndefined();
      expect(terminal.id).toBe("aux:pane-split-0");
      expect(terminal.command).toBe("host-aux");
      terminal.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
