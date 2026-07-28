import type { HostSpawnParams } from "@station/host";
import { describe, expect, it } from "bun:test";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../terminal/testing/scriptedTerminal.js";
import { createPtyTable } from "./ptyTable.js";

const baseParams: HostSpawnParams = {
  kind: "agent",
  terminalTargetId: "native:wt-1",
  worktreeId: "wt-1",
  projectId: "proj-1",
  sessionId: "ses-1",
  worktreePath: "/repo/wt-1",
  harnessProvider: "claude",
  command: "claude",
  args: [],
  cwd: "/repo/wt-1",
  cols: 80,
  rows: 24,
};

function tableWithScripted() {
  const scripteds: ScriptedTerminal[] = [];
  const table = createPtyTable({
    createTerminal: () => {
      const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
      scripteds.push(scripted);
      return scripted.terminal;
    },
  });
  return { table, scripteds };
}

function singleTable() {
  const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
  const table = createPtyTable({ createTerminal: () => scripted.terminal });
  return { table, scripted };
}

describe("createPtyTable", () => {
  it("fails closed on daemon color controls and tmux provenance for persistent Host spawns", () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    let received: StationTerminalSpawnOptions | undefined;
    const table = createPtyTable({
      createTerminal: (options) => {
        received = options;
        return scripted.terminal;
      },
    });

    table.spawn({
      ...baseParams,
      env: {
        TMUX: "/tmp/tmux-501/stale-launch,222,0",
        TMUX_PANE: "%7",
        USER_SETTING: "ordinary",
      },
    });

    expect(received?.env).toEqual({
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      TMUX: undefined,
      TMUX_PANE: undefined,
      USER_SETTING: "ordinary",
    });
    expect(Object.hasOwn(received?.env ?? {}, "FORCE_COLOR")).toBe(true);
    expect(Object.hasOwn(received?.env ?? {}, "NO_COLOR")).toBe(true);
  });

  it("preserves color controls explicitly carried by the launch request", () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    let received: StationTerminalSpawnOptions | undefined;
    const table = createPtyTable({
      createTerminal: (options) => {
        received = options;
        return scripted.terminal;
      },
    });

    table.spawn({
      ...baseParams,
      env: {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });

    expect(received?.env).toMatchObject({
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    });
  });

  it("spawns, captures output into the ring, and lists the live PTY", () => {
    const { table, scripteds } = tableWithScripted();
    const { ptyId } = table.spawn(baseParams);

    scripteds[0]?.helpers.emitData("hello ");
    scripteds[0]?.helpers.emitData("world");

    expect(table.snapshot(ptyId)).toMatchObject({
      exited: false,
      scrollback: ["hello ", "world"],
      truncated: false,
    });
    expect(table.list()).toMatchObject([{ ptyId, worktreeId: "wt-1", alive: true }]);
  });

  it("stores and broadcasts the same compatible output and reports only the first rewrite", async () => {
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const scripted = createScriptedTerminal({ cols: 80, rows: 51 });
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      onEvent: (event, attributes) => events.push({ event, attributes }),
    });
    const { ptyId } = table.spawn({
      ...baseParams,
      rows: 51,
      outputCompatibility: "top-region-scrollback",
    });
    const attachment = table.attach(ptyId);
    const iterator = attachment.frames[Symbol.asyncIterator]();
    const input = "\x1b[1;50r\x1b[3S\x1b[r\x1b[48;1H\x1b[J";
    const expected = "\x1b[r\x1b[999;1H\n\n\n\x1b[H\x1b[48;1H\x1b[J";

    scripted.helpers.emitData(input);
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId, data: expected },
    });
    expect(table.snapshot(ptyId).scrollback).toEqual([expected]);

    scripted.helpers.emitData(input);
    expect(await iterator.next()).toMatchObject({ value: { data: expected } });
    expect(events.filter(({ event }) => event === "pty.output.compatibility-rewrite")).toEqual([
      {
        event: "pty.output.compatibility-rewrite",
        attributes: { ptyId, policy: "top-region-scrollback", count: 1 },
      },
    ]);
    await iterator.return?.();
  });

  it("keeps policy-disabled output byte-for-byte exact", () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const input = "\x1b[1;23r\x1b[3S\x1b[r";

    scripted.helpers.emitData(input);

    expect(table.snapshot(ptyId).scrollback).toEqual([input]);
  });

  it("flushes an incomplete compatibility prefix before the exit frame", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn({
      ...baseParams,
      outputCompatibility: "top-region-scrollback",
    });
    const iterator = table.attach(ptyId).frames[Symbol.asyncIterator]();
    const partial = "before\x1b[1;23r\x1b[";

    scripted.helpers.emitData(partial);
    table.close(ptyId);

    const first = await iterator.next();
    const second = await iterator.next();
    expect(`${first.value?.type === "data" ? first.value.data : ""}${
      second.value?.type === "data" ? second.value.data : ""
    }`).toBe(partial);
    expect(await iterator.next()).toMatchObject({ value: { type: "exit" } });
  });

  it("flushes buffered compatibility bytes before an ordered resize barrier", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn({
      ...baseParams,
      outputCompatibility: "top-region-scrollback",
    });
    const iterator = table.attach(ptyId).frames[Symbol.asyncIterator]();
    const partial = "before\x1b[1;23r\x1b[";

    scripted.helpers.emitData(partial);
    table.resize(ptyId, 100, 30);

    expect(await iterator.next()).toMatchObject({ value: { type: "data", data: "before" } });
    expect(await iterator.next()).toMatchObject({
      value: { type: "data", data: "\x1b[1;23r\x1b[" },
    });
    expect(await iterator.next()).toMatchObject({
      value: { type: "resize", cols: 100, rows: 30 },
    });
    expect(table.attach(ptyId).ack.replay.events).toEqual([
      { type: "data", data: "before" },
      { type: "data", data: "\x1b[1;23r\x1b[" },
      { type: "resize", cols: 100, rows: 30 },
    ]);
    await iterator.return?.();
  });

  it("bounds the default warm-reattach replay to 256 KiB", () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const chunk = "x".repeat(1024);

    for (let index = 0; index < 300; index += 1) {
      scripted.helpers.emitData(chunk);
    }

    const snapshot = table.snapshot(ptyId);
    expect(snapshot.scrollback).toHaveLength(256);
    expect(snapshot.scrollback.every((entry) => entry === chunk)).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });

  it("reuses the live PTY for the same worktree (idempotent spawn)", () => {
    const { table, scripteds } = tableWithScripted();
    const first = table.spawn(baseParams);
    const second = table.spawn(baseParams);
    expect(second.ptyId).toBe(first.ptyId);
    expect(scripteds).toHaveLength(1);
    expect(table.list()).toHaveLength(1);
  });

  it("keeps distinct terminal targets as separate live PTYs", () => {
    const scripteds: ScriptedTerminal[] = [];
    let nextPid = 4200;
    const table = createPtyTable({
      createTerminal: () => {
        const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
        (scripted.terminal as { pid: number }).pid = nextPid;
        nextPid += 1;
        scripteds.push(scripted);
        return scripted.terminal;
      },
    });

    const first = table.spawn(baseParams);
    const second = table.spawn({
      ...baseParams,
      terminalTargetId: "native:wt-2",
      worktreeId: "wt-2",
      sessionId: "ses-2",
      worktreePath: "/repo/wt-2",
      cwd: "/repo/wt-2",
    });

    expect(first).toEqual({ ptyId: "pty-1", pid: 4200 });
    expect(second).toEqual({ ptyId: "pty-2", pid: 4201 });
    expect(scripteds).toHaveLength(2);
    expect(table.list().map((entry) => [entry.terminalTargetId, entry.ptyId, entry.pid])).toEqual([
      ["native:wt-1", "pty-1", 4200],
      ["native:wt-2", "pty-2", 4201],
    ]);
  });

  it("forwards writes and clamped resizes to the terminal", () => {
    const { table, scripteds } = tableWithScripted();
    const { ptyId } = table.spawn(baseParams);
    table.write(ptyId, "ls\n");
    table.resize(ptyId, 1, 0); // below MIN_COLS/MIN_ROWS — clamps to 2x1
    expect(scripteds[0]?.helpers.writes).toEqual(["ls\n"]);
    expect(scripteds[0]?.helpers.resizes).toEqual([{ cols: 2, rows: 1 }]);
    expect(table.list()[0]).toMatchObject({ cols: 2, rows: 1 });
  });

  it("reaps a PTY from the table when it exits naturally (no dead-entry leak)", () => {
    const { table, scripteds } = tableWithScripted();
    table.spawn(baseParams);
    scripteds[0]?.helpers.emitExit({ exitCode: 0 });
    // Reaped: dropped from the table (so a long-lived host never accumulates dead
    // entries) and the terminal disposed.
    expect(table.list()).toEqual([]);
    expect(scripteds[0]?.helpers.isDisposed()).toBe(true);
  });

  it("does not insert a dead entry when output and exit replay during subscription", () => {
    const events: string[] = [];
    let disposed = false;
    const terminal: StationTerminalProcess = {
      id: "immediate",
      command: "true",
      pid: 42,
      size: { cols: 80, rows: 24 },
      onData(listener) {
        listener("complete");
        return { dispose() {} };
      },
      onExit(listener) {
        listener({ exitCode: 0 });
        return { dispose() {} };
      },
      onDiagnostic() {
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {},
      dispose() {
        disposed = true;
      },
    };
    const table = createPtyTable({
      createTerminal: () => terminal,
      onEvent: (event) => events.push(event),
    });

    table.spawn(baseParams);

    expect(table.list()).toEqual([]);
    expect(disposed).toBe(true);
    expect(events).toEqual(["agent.spawn", "agent.exit"]);
  });

  it("does not accumulate a duplicate target when a worktree's PTY exits then relaunches", () => {
    const { table, scripteds } = tableWithScripted();
    table.spawn(baseParams);
    scripteds[0]?.helpers.emitExit({ exitCode: 0 }); // reaped
    const again = table.spawn(baseParams); // relaunch same worktree
    expect(again.ptyId).toBe("pty-2");
    expect(table.list().map((entry) => entry.ptyId)).toEqual(["pty-2"]); // one, not two
  });

  it("throws HOST_PTY_NOT_FOUND for an unknown PTY", () => {
    const { table } = tableWithScripted();
    expect(() => table.write("pty-nope", "x")).toThrow();
  });

  it("attach acks an atomic scrollback snapshot, then streams live frames", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("before-"); // lands in the ring (snapshot)

    const { ack, frames } = table.attach(ptyId);
    expect(ack).toMatchObject({
      ptyId,
      exited: false,
      replay: {
        initialCols: 80,
        initialRows: 24,
        events: [{ type: "data", data: "before-" }],
        truncated: false,
      },
    });

    const iterator = frames[Symbol.asyncIterator]();
    scripted.helpers.emitData("after"); // live frame
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId, data: "after" },
    });
    await iterator.return?.();
  });

  it("orders live data around the resize barrier applied by the Host", async () => {
    const scripted = createScriptedTerminal({ cols: 10, rows: 4 });
    const table = createPtyTable({ createTerminal: () => scripted.terminal });
    const { ptyId } = table.spawn({ ...baseParams, cols: 10, rows: 4 });
    const iterator = table.attach(ptyId).frames[Symbol.asyncIterator]();

    scripted.helpers.emitData("before-resize");
    table.resize(ptyId, 5, 4);
    scripted.helpers.emitData("after-resize");

    const frames = await Promise.all([iterator.next(), iterator.next(), iterator.next()]);
    expect(frames.map(({ value }) => value)).toEqual([
      { type: "data", ptyId, data: "before-resize" },
      { type: "resize", ptyId, cols: 5, rows: 4 },
      { type: "data", ptyId, data: "after-resize" },
    ]);
    expect(table.attach(ptyId).ack.replay).toEqual({
      initialCols: 10,
      initialRows: 4,
      events: [
        { type: "data", data: "before-resize" },
        { type: "resize", cols: 5, rows: 4 },
        { type: "data", data: "after-resize" },
      ],
      truncated: false,
    });
    await iterator.return?.();
  });

  it("replays the same scrollback to a second attachment", () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("xyz");
    expect(table.attach(ptyId).ack.replay.events).toEqual([{ type: "data", data: "xyz" }]);
    expect(table.attach(ptyId).ack.replay.events).toEqual([{ type: "data", data: "xyz" }]);
  });

  it("broadcasts data and exit to every attachment, then ends each stream", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const a = table.attach(ptyId).frames[Symbol.asyncIterator]();
    const b = table.attach(ptyId).frames[Symbol.asyncIterator]();

    scripted.helpers.emitData("hi");
    expect(await a.next()).toMatchObject({ value: { type: "data", data: "hi" } });
    expect(await b.next()).toMatchObject({ value: { type: "data", data: "hi" } });

    scripted.helpers.emitExit({ exitCode: 0 });
    expect(await a.next()).toMatchObject({ value: { type: "exit", exitCode: 0 } });
    expect(await b.next()).toMatchObject({ value: { type: "exit", exitCode: 0 } });
    expect(await a.next()).toEqual({ done: true, value: undefined });
  });

  it("detach (frames.return) leaves the PTY alive", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    await table.attach(ptyId).frames[Symbol.asyncIterator]().return?.();
    expect(table.list()[0]).toMatchObject({ ptyId, alive: true });
    expect(scripted.helpers.isDisposed()).toBe(false);
  });

  it("close kills the PTY, broadcasts exit to attachments, and drops it from the table", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const frames = table.attach(ptyId).frames[Symbol.asyncIterator]();

    expect(table.close(ptyId)).toBe(true);
    expect(scripted.helpers.isDisposed()).toBe(true);
    expect(table.list()).toEqual([]);
    expect(await frames.next()).toMatchObject({ value: { type: "exit", ptyId } });
    // Idempotent: closing an unknown PTY is a no-op.
    expect(table.close(ptyId)).toBe(false);
  });

  it("disposeAll broadcasts exit to attachments so streams end (no hang on shutdown)", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const frames = table.attach(ptyId).frames[Symbol.asyncIterator]();
    table.disposeAll();
    expect(scripted.helpers.isDisposed()).toBe(true);
    expect(await frames.next()).toMatchObject({ value: { type: "exit", ptyId } });
    expect(await frames.next()).toEqual({ done: true, value: undefined });
  });

  it("attaching after a PTY has exited (and been reaped) is HOST_ATTACH_GONE", () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("done");
    scripted.helpers.emitExit({ exitCode: 3 }); // reaped
    expect(() => table.attach(ptyId)).toThrow();
  });
});
