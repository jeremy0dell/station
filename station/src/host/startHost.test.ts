import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient } from "@station/host";
import { afterEach, describe, expect, it } from "bun:test";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { StationTerminalSpawnError } from "../terminal/pty/errors.js";
import { type StationHostInstance, startStationHost } from "./startHost.js";

// startStationHost only calls logger.log; a no-op keeps the host test off the FS.
const noopLogger = { log: async () => undefined } as never;

let host: StationHostInstance | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

async function startOnTempSocket(
  ptyTableOptions?: Parameters<typeof startStationHost>[0]["ptyTableOptions"],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "station-host-"));
  const socketPath = join(dir, "station-host.sock");
  host = await startStationHost({
    socketPath,
    stateDir: dir,
    logger: noopLogger,
    ...(ptyTableOptions === undefined ? {} : { ptyTableOptions }),
  });
  return socketPath;
}

const identity = {
  terminalTargetId: "native:wt-1",
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
};

describe("startStationHost", () => {
  it("answers host.health over a real unix socket", async () => {
    const socketPath = await startOnTempSocket();
    const client = createStationHostClient({ socketPath });
    try {
      expect(await client.health()).toEqual({ ok: true, protocolVersion: 1 });
    } finally {
      client.dispose();
    }
  });

  it("records the selected PTY implementation at startup", async () => {
    const previous = process.env.STATION_PTY_IMPL;
    process.env.STATION_PTY_IMPL = "bun-nocctty";
    const records: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    const dir = await mkdtemp(join(tmpdir(), "station-host-log-"));
    try {
      host = await startStationHost({
        socketPath: join(dir, "station-host.sock"),
        stateDir: dir,
        logger: {
          log: async (record: (typeof records)[number]) => {
            records.push(record);
          },
        } as never,
      });

      expect(records[0]).toMatchObject({
        message: "host.start",
        attributes: { ptyImplementation: "bun-nocctty" },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.STATION_PTY_IMPL;
      } else {
        process.env.STATION_PTY_IMPL = previous;
      }
    }
  });

  it("handles host.focus (best-effort) over a real unix socket", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = createStationHostClient({ socketPath });
    try {
      const { ptyId } = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      // Resolves (not HOST_BAD_REQUEST as it would if host.focus were unwired);
      // best-effort, so focusing a missing PTY also resolves.
      await client.focus(ptyId);
      await client.focus("pty-missing");
      expect(await client.health()).toEqual({ ok: true, protocolVersion: 1 });
    } finally {
      client.dispose();
    }
  });

  it("spawns a PTY, lists it, and forwards writes over the socket", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = createStationHostClient({ socketPath });
    try {
      const { ptyId } = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      expect(ptyId).toBe("pty-1");

      const listed = await client.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ ptyId, worktreeId: "wt-1", alive: true });

      await client.write(ptyId, "ls\n");
      expect(scripted.helpers.writes).toEqual(["ls\n"]);

      // Idempotent: re-spawning the same worktree returns the same PTY.
      const again = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      expect(again.ptyId).toBe(ptyId);
      expect(await client.list()).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("returns an actionable PTY spawn failure over the host protocol", async () => {
    const socketPath = await startOnTempSocket({
      createTerminal: () => {
        throw new StationTerminalSpawnError(
          "/bin/sh",
          new Error("helper unavailable"),
          "Run `bun run build:ctty-helper` from station/.",
        );
      },
    });
    const client = createStationHostClient({ socketPath });
    try {
      await expect(
        client.spawn({
          ...identity,
          command: "/bin/sh",
          args: [],
          cwd: "/repo/wt-1",
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({
        code: "HOST_SPAWN_FAILED",
        message: "Failed to spawn terminal for /bin/sh. Run `bun run build:ctty-helper` from station/.",
      });
    } finally {
      client.dispose();
    }
  });

  it("attach replays scrollback then streams live frames; detach keeps the PTY", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = createStationHostClient({ socketPath });
    try {
      const { ptyId } = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });

      scripted.helpers.emitData("scroll-"); // captured into the ring before attach
      const attachment = await client.attach(ptyId);
      expect(attachment.ack.scrollback).toEqual(["scroll-"]);

      const iterator = attachment.frames[Symbol.asyncIterator]();
      scripted.helpers.emitData("live");
      expect(await iterator.next()).toMatchObject({ value: { type: "data", data: "live" } });

      await attachment.detach();
      expect((await client.list())[0]).toMatchObject({ ptyId, alive: true });
    } finally {
      client.dispose();
    }
  });

  it("host.close drops the PTY; attaching to a missing PTY is HOST_ATTACH_GONE", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = createStationHostClient({ socketPath });
    try {
      const { ptyId } = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      expect(await client.close(ptyId)).toEqual({ closed: true });
      expect(await client.list()).toEqual([]);

      // A first-class diagnosable failure — never a silent fall-through to respawn.
      await expect(client.attach("pty-missing")).rejects.toMatchObject({
        tag: "TerminalProviderError",
        provider: "native",
        code: "HOST_ATTACH_GONE",
      });
    } finally {
      client.dispose();
    }
  });
});
