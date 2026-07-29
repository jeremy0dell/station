import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStationHostClient, HOST_PROTOCOL_VERSION } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import { afterEach, describe, expect, it } from "bun:test";
import { paneInputBytes } from "../input/runtime/sequenceNormalize.js";
import { createHostAttachedTerminal } from "../terminal/pty/hostAttachedTerminal.js";
import { StationTerminalSpawnError } from "../terminal/pty/errors.js";
import { createPtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
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
      expect(await client.health()).toEqual({
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: stationBuildInfo().version,
      });
    } finally {
      client.dispose();
    }
  });

  it("records the selected PTY implementation at startup", async () => {
    const records: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    const dir = await mkdtemp(join(tmpdir(), "station-host-log-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      ptyImplementation: "bun-nocctty",
      logger: {
        log: async (record: (typeof records)[number]) => {
          records.push(record);
        },
      } as never,
    });

    expect(records[0]).toMatchObject({
      message: "host.start",
      attributes: {
        ptyImplementation: "bun-nocctty",
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: stationBuildInfo().version,
      },
    });
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
      expect(await client.health()).toEqual({
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: stationBuildInfo().version,
      });
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
      expect(attachment.ack.replay).toEqual({
        kind: "raw-complete",
        initialCols: 80,
        initialRows: 24,
        events: [{ type: "data", data: "scroll-" }],
      });

      const iterator = attachment.frames[Symbol.asyncIterator]();
      scripted.helpers.emitData("live");
      expect(await iterator.next()).toMatchObject({ value: { type: "data", data: "live" } });

      await attachment.detach();
      expect((await client.list())[0]).toMatchObject({ ptyId, alive: true });
    } finally {
      client.dispose();
    }
  });

  it("applies output compatibility before replay and live delivery", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 51 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = createStationHostClient({ socketPath });
    try {
      const { ptyId } = await client.spawn({
        ...identity,
        command: "codex",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 51,
        outputCompatibility: "top-region-scrollback",
      });
      const input = "\x1b[1;50r\x1b[3S\x1b[r\x1b[48;1H\x1b[J";
      const expected = "\x1b[r\x1b[999;1H\n\n\n\x1b[H\x1b[48;1H\x1b[J";

      scripted.helpers.emitData(input);
      const attachment = await client.attach(ptyId);
      expect(attachment.ack.replay).toEqual({
        kind: "raw-complete",
        initialCols: 80,
        initialRows: 51,
        events: [{ type: "data", data: expected }],
      });

      const iterator = attachment.frames[Symbol.asyncIterator]();
      scripted.helpers.emitData(input);
      expect(await iterator.next()).toMatchObject({ value: { type: "data", data: expected } });
      await attachment.detach();
    } finally {
      client.dispose();
    }
  });

  it("restores interaction modes through a degraded Host reattach and registry path", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({
      createTerminal: () => scripted.terminal,
      maxScrollbackBytes: 5,
    });
    const client = createStationHostClient({ socketPath });
    const registry = createPtyRegistry({ resizeDebounceMs: 0 });
    const paneId = "pane-degraded-host-reattach";
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const initial = await client.attach(spawned.ptyId);
      await initial.detach();

      scripted.helpers.emitData("overflowing-history");
      scripted.helpers.emitData(
        "\x1b[?1h\x1b[?66h\x1b[?2004h" +
          "\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[=5u\x1b(0",
      );

      registry.ensure(paneId, undefined, () =>
        createHostAttachedTerminal({
          hostSocketPath: socketPath,
          ptyId: spawned.ptyId,
          size: { cols: 80, rows: 24 },
        }),
      );
      registry.resize(paneId, { cols: 80, rows: 24 });

      await waitFor(() => {
        const entry = registry.get(paneId);
        return (
          entry?.terminal?.pid === spawned.pid &&
          entry.screen?.isBracketedPasteEnabled() === true &&
          entry.screen.isApplicationCursorKeys() &&
          entry.screen.mouseProtocol()?.tracking === "any" &&
          entry.screen.mouseProtocol()?.encoding === "sgr" &&
          entry.screen.isKittyKeyboardEnabled() &&
          scripted.helpers.resizes.length >= 3
        );
      });

      const entry = registry.get(paneId);
      expect(entry?.terminal?.pid).toBe(spawned.pid);
      expect(entry?.exited).toBe(false);
      expect(entry?.status).not.toBe("attachment unavailable");
      expect(await client.list()).toMatchObject([
        { ptyId: spawned.ptyId, pid: spawned.pid, alive: true },
      ]);

      expect(registry.write(paneId, paneInputBytes("\x1b[B", registry, paneId))).toBe(true);
      expect(registry.paste(paneId, "pasted")).toBe(true);
      await waitFor(
        () =>
          scripted.helpers.writes.includes("\x1bOB") &&
          scripted.helpers.writes.includes("\x1b[200~pasted\x1b[201~"),
      );

      scripted.helpers.emitData("live-after-reset");
      await waitFor(() => entry?.screen?.rowText(0).includes("live-after-reset") === true);

      registry.resize(paneId, { cols: 100, rows: 30 });
      await waitFor(
        () =>
          scripted.helpers.resizes.some(({ cols, rows }) => cols === 100 && rows === 30) &&
          entry?.screen?.bufferStats().cols === 100 &&
          entry.screen.bufferStats().rows === 30,
      );

      expect(entry?.exited).toBe(false);
      expect(entry?.status).not.toBe("attachment unavailable");
    } finally {
      registry.disposeAll();
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

  it("stops an idle host only after acknowledging the lifecycle request", async () => {
    const socketPath = await startOnTempSocket();
    const client = createStationHostClient({ socketPath });
    try {
      expect(await client.stopIfIdle("next-build")).toEqual({ stopping: true });
      await host?.closed;
      await host?.close();
    } finally {
      client.dispose();
    }
  });

  it("blocks upgrades with live agent and auxiliary PTYs without disrupting attachments", async () => {
    const agent = createScriptedTerminal({ cols: 80, rows: 24 });
    const auxiliary = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminals = [agent.terminal, auxiliary.terminal];
    const socketPath = await startOnTempSocket({
      createTerminal: () => {
        const terminal = terminals.shift();
        if (terminal === undefined) {
          throw new Error("unexpected terminal spawn");
        }
        return terminal;
      },
    });
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
      await client.spawn({
        ...identity,
        kind: "aux",
        terminalTargetId: "aux:pane-shell",
        worktreeId: "pane-shell",
        sessionId: "pane-shell",
        command: "/bin/sh",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });

      agent.helpers.emitData("scrollback");
      const attachment = await client.attach(ptyId);
      expect(attachment.ack.replay).toEqual({
        kind: "raw-complete",
        initialCols: 80,
        initialRows: 24,
        events: [{ type: "data", data: "scrollback" }],
      });
      const frames = attachment.frames[Symbol.asyncIterator]();

      await expect(client.stopIfIdle("next-build")).rejects.toMatchObject({
        code: "HOST_UPGRADE_BLOCKED",
      });
      expect(await client.list()).toHaveLength(2);

      agent.helpers.emitData("still-live");
      await expect(frames.next()).resolves.toMatchObject({
        value: { type: "data", data: "still-live" },
      });
      await attachment.detach();
    } finally {
      client.dispose();
    }
  });

  it("serializes stop-if-idle and spawn safely across clients", async () => {
    let spawnCount = 0;
    const socketPath = await startOnTempSocket({
      createTerminal: () => {
        spawnCount += 1;
        return createScriptedTerminal({ cols: 80, rows: 24 }).terminal;
      },
    });
    const stoppingClient = createStationHostClient({ socketPath });
    const spawningClient = createStationHostClient({ socketPath });
    try {
      await Promise.all([stoppingClient.list(), spawningClient.list()]);
      const [stopping, spawning] = await Promise.allSettled([
        stoppingClient.stopIfIdle("next-build"),
        spawningClient.spawn({
          ...identity,
          command: "claude",
          args: [],
          cwd: "/repo/wt-1",
          cols: 80,
          rows: 24,
        }),
      ]);

      if (stopping.status === "fulfilled") {
        expect(stopping.value).toEqual({ stopping: true });
        expect(spawning.status).toBe("rejected");
        if (spawning.status === "rejected") {
          expect(["HOST_UPGRADE_BLOCKED", "HOST_UNREACHABLE"]).toContain(
            (spawning.reason as { code?: string }).code,
          );
        }
        expect(spawnCount).toBe(0);
        await host?.closed;
      } else {
        expect(stopping.reason).toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });
        expect(spawning.status).toBe("fulfilled");
        expect(spawnCount).toBe(1);
        expect(await spawningClient.list()).toHaveLength(1);
      }
    } finally {
      stoppingClient.dispose();
      spawningClient.dispose();
    }
  });
});
