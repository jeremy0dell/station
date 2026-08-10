import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStationHostClient,
  HOST_PROTOCOL_VERSION,
  type HostPtyAttachExpectation,
  type HostSpawnResult,
} from "@station/host";
import { afterEach, describe, expect, it } from "bun:test";
import { paneInputBytes } from "../../input/runtime/sequenceNormalize.js";
import { createHostAttachedTerminal } from "../../terminal/pty/hostAttachedTerminal.js";
import { StationTerminalSpawnError } from "../../terminal/pty/errors.js";
import { createPtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../../terminal/testing/waitFor.js";
import { type StationHostInstance, startStationHost } from "../startHost.js";

// startStationHost only calls logger.log; a no-op keeps the host test off the FS.
const noopLogger = { log: async () => undefined } as never;
const TEST_HOST_BUILD = "test-host-build";

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
    // Keep hermetic unit runs off checkout build-identity verification.
    buildVersion: TEST_HOST_BUILD,
    ...(ptyTableOptions === undefined ? {} : { ptyTableOptions }),
  });
  return socketPath;
}

function testClient(socketPath: string, timeoutMs?: number) {
  return createStationHostClient({
    socketPath,
    expectedBuildVersion: TEST_HOST_BUILD,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const identity = {
  kind: "agent" as const,
  terminalTargetId: "native:wt-1",
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
};

function attachExpectation(spawned: HostSpawnResult): HostPtyAttachExpectation {
  return { ...identity, ...spawned };
}

describe("startStationHost", () => {
  it("answers host.health over a real unix socket", async () => {
    const socketPath = await startOnTempSocket();
    const client = testClient(socketPath);
    try {
      expect(await client.health()).toEqual({
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: TEST_HOST_BUILD,
      });
    } finally {
      client.dispose();
    }
  });

  it("closes after a one-way client shutdown notification over a real socket", async () => {
    const socketPath = await startOnTempSocket();
    const client = testClient(socketPath);
    await client.list();

    client.dispose();
    await Promise.race([
      host?.close(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Station Host close timed out.")), 1_000);
      }),
    ]);
    host = undefined;
  });

  it("records the selected PTY implementation at startup", async () => {
    const records: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    const dir = await mkdtemp(join(tmpdir(), "station-host-log-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      ptyImplementation: "bun-nocctty",
      buildVersion: TEST_HOST_BUILD,
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
        buildVersion: TEST_HOST_BUILD,
      },
    });
  });

  it("records PTY spawn and exit independently from attachment lifecycle", async () => {
    const records: Array<{
      lifecycle?: { kind: string; ptyId?: string; pid?: number; exitCode?: number };
    }> = [];
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const dir = await mkdtemp(join(tmpdir(), "station-host-pty-lifecycle-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      buildVersion: TEST_HOST_BUILD,
      ptyTableOptions: { createTerminal: () => scripted.terminal },
      logger: { log: async (record: (typeof records)[number]) => records.push(record) } as never,
    });
    const client = testClient(join(dir, "station-host.sock"));
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const { ptyId } = spawned;
      scripted.helpers.emitExit({ exitCode: 17 });
      await waitFor(() => records.some((record) => record.lifecycle?.kind === "host.pty.exited"));

      const lifecycle = records.map((record) => record.lifecycle).filter(Boolean);
      expect(lifecycle.find((event) => event?.kind === "host.pty.spawned")).toMatchObject({
        kind: "host.pty.spawned",
        ptyId,
        pid: scripted.terminal.pid,
      });
      expect(lifecycle.find((event) => event?.kind === "host.pty.exited")).toMatchObject({
        kind: "host.pty.exited",
        ptyId,
        exitCode: 17,
      });
    } finally {
      client.dispose();
    }
  });

  it("handles host.focus (best-effort) over a real unix socket", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = testClient(socketPath);
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const { ptyId } = spawned;
      // Resolves (not HOST_BAD_REQUEST as it would if host.focus were unwired);
      // best-effort, so focusing a missing PTY also resolves.
      await client.focus(ptyId);
      await client.focus("pty-missing");
      expect(await client.health()).toEqual({
        ok: true,
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildVersion: TEST_HOST_BUILD,
      });
    } finally {
      client.dispose();
    }
  });

  it("spawns a PTY, lists it, and forwards writes over the socket", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = testClient(socketPath);
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const { ptyId } = spawned;
      expect(ptyId).toBe("pty-1");

      const listed = await client.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ ptyId, worktreeId: "wt-1", alive: true });

      const attachment = await client.attach(attachExpectation(spawned), "controller");
      await attachment.write("ls\n");
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
    const client = testClient(socketPath);
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
    const client = testClient(socketPath);
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const { ptyId } = spawned;

      scripted.helpers.emitData("scroll-"); // captured into the ring before attach
      const attachment = await client.attach(attachExpectation(spawned), "viewer");
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

  it("fans out output while serializing two clients through one controller lease", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const firstClient = testClient(socketPath);
    const secondClient = testClient(socketPath);
    try {
      const spawned = await firstClient.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const expectation = attachExpectation(spawned);
      const first = await firstClient.attach(expectation, "controller");
      const second = await secondClient.attach(expectation, "viewer");
      const firstFrames = first.frames[Symbol.asyncIterator]();
      const secondFrames = second.frames[Symbol.asyncIterator]();

      scripted.helpers.emitData("shared");
      await expect(firstFrames.next()).resolves.toMatchObject({ value: { data: "shared" } });
      await expect(secondFrames.next()).resolves.toMatchObject({ value: { data: "shared" } });
      await expect(second.resize(40, 10)).rejects.toMatchObject({
        code: "HOST_CONTROL_REVOKED",
      });
      expect(scripted.helpers.resizes).toEqual([]);

      await expect(second.claimControl()).resolves.toMatchObject({
        role: "controller",
        controlEpoch: 2,
      });
      await expect(firstFrames.next()).resolves.toMatchObject({
        value: {
          type: "control-revoked",
          attachmentId: first.ack.attachmentId,
          controlEpoch: 2,
        },
      });
      await expect(first.write("stale")).rejects.toMatchObject({
        code: "HOST_CONTROL_REVOKED",
      });
      await second.resize(100, 30);
      await second.write("accepted");
      expect(scripted.helpers.resizes).toEqual([{ cols: 100, rows: 30 }]);
      expect(scripted.helpers.writes).toEqual(["accepted"]);

      await second.detach();
      await expect(first.write("not-promoted")).rejects.toMatchObject({
        code: "HOST_CONTROL_REVOKED",
      });
      await expect(first.claimControl()).resolves.toMatchObject({
        role: "controller",
        controlEpoch: 3,
      });
    } finally {
      firstClient.dispose();
      secondClient.dispose();
    }
  });

  it("applies output compatibility before replay and live delivery", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 51 });
    const socketPath = await startOnTempSocket({ createTerminal: () => scripted.terminal });
    const client = testClient(socketPath);
    try {
      const spawned = await client.spawn({
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
      const attachment = await client.attach(attachExpectation(spawned), "viewer");
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
    const client = testClient(socketPath);
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
      const initial = await client.attach(attachExpectation(spawned), "viewer");
      await initial.detach();

      scripted.helpers.emitData("overflowing-history");
      scripted.helpers.emitData(
        "\x1b[?1h\x1b[?66h\x1b[?2004h" +
          "\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[=5u\x1b(0",
      );

      registry.ensure(paneId, undefined, () =>
        createHostAttachedTerminal({
          hostSocketPath: socketPath,
          ptyRef: attachExpectation(spawned),
          size: { cols: 80, rows: 24 },
          clientFactory: (path) =>
            createStationHostClient({
              socketPath: path,
              expectedBuildVersion: TEST_HOST_BUILD,
            }),
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
    const client = testClient(socketPath);
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
      await expect(
        client.attach(
          {
            ...identity,
            terminalTargetId: "native:missing",
            ptyId: "pty-missing",
            ptyInstanceId: "missing-instance",
          },
          "viewer",
        ),
      ).rejects.toMatchObject({
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
    const client = testClient(socketPath);
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
    const client = testClient(socketPath);
    try {
      const spawned = await client.spawn({
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
      const attachment = await client.attach(attachExpectation(spawned), "viewer");
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
    const stoppingClient = testClient(socketPath);
    const spawningClient = testClient(socketPath);
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

  it("beginHandoff parks bridge-capable PTYs and completeHandoff exits without disposeAll kill", async () => {
    let released = false;
    let killed = false;
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminal = {
      ...scripted.terminal,
      bridgePid: 9_001,
      releaseToOrphan() {
        released = true;
        scripted.helpers.isDisposed();
        scripted.terminal.dispose();
        return false;
      },
      kill() {
        killed = true;
        scripted.terminal.kill();
      },
      dispose() {
        // Intentionally empty: releaseToOrphan owns park; dispose must not kill parks.
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "station-host-handoff-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: { createTerminal: () => terminal },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const begun = await client.beginHandoff("host-b", "processes");
      expect(begun.released).toEqual(["pty-1"]);
      expect(begun.manifest["pty-1"]?.bridgePid).toEqual(9_001);
      expect(released).toEqual(true);
      await expect(client.list()).rejects.toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });
      await expect(client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      })).rejects.toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });

      expect(await client.completeHandoff()).toEqual({ stopping: true });
      await host?.closed;
      host = undefined;
      expect(killed).toEqual(false);
    } finally {
      client.dispose();
    }
  });

  it("refuses adoptRegistry while a handoff is in progress", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminal = {
      ...scripted.terminal,
      bridgePid: 9_012,
      releaseToOrphan() {
        return false;
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "station-host-adopt-gate-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: { createTerminal: () => terminal },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      const begun = await client.beginHandoff("host-b");
      await expect(client.adoptRegistry(begun.manifest)).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      await client.abortHandoff();
    } finally {
      client.dispose();
    }
  });

  it("abortHandoff restores serving after beginHandoff", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminal = {
      ...scripted.terminal,
      bridgePid: 9_002,
      releaseToOrphan() {
        scripted.terminal.dispose();
        return false;
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "station-host-abort-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: {
        createTerminal: () => terminal,
        adoptTerminal: async () => ({
          ...createScriptedTerminal({ cols: 80, rows: 24 }).terminal,
          bridgePid: 9_002,
          parkedEvicted: false,
          releaseToOrphan: () => false,
        }),
      },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      await client.beginHandoff("host-b");
      const aborted = await client.abortHandoff();
      expect(aborted.adopted).toEqual(["pty-1"]);
      expect(await client.list()).toHaveLength(1);
      await client.spawn({
        ...identity,
        terminalTargetId: "native:wt-2",
        worktreeId: "wt-2",
        sessionId: "ses-2",
        command: "claude",
        args: [],
        cwd: "/repo/wt-2",
        cols: 80,
        rows: 24,
      });
      expect(await client.list()).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });

  it("refuses beginHandoff without live PTYs and complete without begin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-host-empty-handoff-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-empty",
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-empty",
    });
    try {
      await expect(client.beginHandoff("next")).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      await expect(client.completeHandoff()).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      await expect(client.abortHandoff()).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
    } finally {
      client.dispose();
    }
  });

  it("refuses double beginHandoff and blocks spawn/attach while still answering health", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminal = {
      ...scripted.terminal,
      bridgePid: 9_003,
      releaseToOrphan() {
        scripted.terminal.dispose();
        return false;
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "station-host-double-begin-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: {
        createTerminal: () => terminal,
        adoptTerminal: async () => ({
          ...createScriptedTerminal({ cols: 80, rows: 24 }).terminal,
          bridgePid: 9_003,
          parkedEvicted: false,
          releaseToOrphan: () => false,
        }),
      },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      const spawned = await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      await client.beginHandoff("host-b", "processes");
      await expect(client.beginHandoff("host-c", "processes")).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      expect(await client.health()).toMatchObject({
        ok: true,
        buildVersion: "host-a",
      });
      await expect(
        client.spawn({
          ...identity,
          terminalTargetId: "native:wt-2",
          worktreeId: "wt-2",
          sessionId: "ses-2",
          command: "claude",
          args: [],
          cwd: "/repo/wt-2",
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });
      await expect(client.attach(attachExpectation(spawned), "viewer")).rejects.toMatchObject({
        code: "HOST_UPGRADE_BLOCKED",
      });
      await client.abortHandoff();
      expect(await client.list()).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("refuses beginHandoff once stopIfIdle has started draining", async () => {
    const dir = await mkdtemp(join(tmpdir(), "station-host-idle-drain-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-idle",
    });
    const stopper = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-idle",
    });
    const handoffClient = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-idle",
      timeoutMs: 1_000,
    });
    try {
      // Empty-host stopIfIdle closes after ack; begin must fail closed (drain,
      // empty-table, or socket-gone) and must never return a manifest.
      const [stopping, handoff] = await Promise.allSettled([
        stopper.stopIfIdle("host-next"),
        handoffClient.beginHandoff("host-next"),
      ]);
      expect(stopping.status).toBe("fulfilled");
      if (stopping.status === "fulfilled") {
        expect(stopping.value).toEqual({ stopping: true });
      }
      expect(handoff.status).toBe("rejected");
      if (handoff.status === "rejected") {
        expect([
          "HOST_HANDOFF_INVALID_STATE",
          "HOST_UNREACHABLE",
          "HOST_REQUEST_FAILED",
        ]).toContain((handoff.reason as { code?: string }).code);
      }
      await host?.closed;
      host = undefined;
    } finally {
      stopper.dispose();
      handoffClient.dispose();
    }
  });

  it("refuses stopIfIdle while a live handoff is in progress", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const terminal = {
      ...scripted.terminal,
      bridgePid: 9_004,
      releaseToOrphan() {
        scripted.terminal.dispose();
        return false;
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "station-host-stop-during-handoff-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: {
        createTerminal: () => terminal,
        adoptTerminal: async () => ({
          ...createScriptedTerminal({ cols: 80, rows: 24 }).terminal,
          bridgePid: 9_004,
          parkedEvicted: false,
          releaseToOrphan: () => false,
        }),
      },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      await client.beginHandoff("host-b");
      await expect(client.stopIfIdle("host-b")).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      await client.abortHandoff();
    } finally {
      client.dispose();
    }
  });

  it("refuses beginHandoff when only non-bridge terminals are live", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const dir = await mkdtemp(join(tmpdir(), "station-host-no-bridge-handoff-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: { createTerminal: () => scripted.terminal },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      await expect(client.beginHandoff("host-b")).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      expect(await client.list()).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("refuses mixed bridge/non-bridge tables without parking anyone", async () => {
    let next = 0;
    let released = false;
    const dir = await mkdtemp(join(tmpdir(), "station-host-mixed-handoff-"));
    host = await startStationHost({
      socketPath: join(dir, "station-host.sock"),
      stateDir: dir,
      logger: noopLogger,
      buildVersion: "host-a",
      ptyTableOptions: {
        createTerminal: () => {
          next += 1;
          const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
          if (next === 1) {
            return {
              ...scripted.terminal,
              bridgePid: 9_005,
              releaseToOrphan() {
                released = true;
                scripted.terminal.dispose();
                return false;
              },
            };
          }
          return scripted.terminal;
        },
      },
    });
    const client = createStationHostClient({
      socketPath: join(dir, "station-host.sock"),
      expectedBuildVersion: "host-a",
    });
    try {
      await client.spawn({
        ...identity,
        command: "claude",
        args: [],
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      });
      await client.spawn({
        ...identity,
        terminalTargetId: "native:wt-2",
        worktreeId: "wt-2",
        sessionId: "ses-2",
        kind: "aux",
        command: "sh",
        args: [],
        cwd: "/repo/wt-2",
        cols: 80,
        rows: 24,
      });
      await expect(client.beginHandoff("host-b", "processes")).rejects.toMatchObject({
        code: "HOST_HANDOFF_INVALID_STATE",
      });
      expect(released).toEqual(false);
      expect(await client.list()).toHaveLength(2);
      // Drain gate must not stick after a refused begin.
      await client.spawn({
        ...identity,
        terminalTargetId: "native:wt-3",
        worktreeId: "wt-3",
        sessionId: "ses-3",
        command: "claude",
        args: [],
        cwd: "/repo/wt-3",
        cols: 80,
        rows: 24,
      });
      expect(await client.list()).toHaveLength(3);
    } finally {
      client.dispose();
    }
  });
});
