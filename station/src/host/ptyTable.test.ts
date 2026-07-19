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
  it("fails closed on tmux provenance for persistent Host spawns", () => {
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
      TMUX: undefined,
      TMUX_PANE: undefined,
      USER_SETTING: "ordinary",
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
    expect(ack).toMatchObject({ ptyId, exited: false, scrollback: ["before-"], truncated: false });

    const iterator = frames[Symbol.asyncIterator]();
    scripted.helpers.emitData("after"); // live frame
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId, data: "after" },
    });
    await iterator.return?.();
  });

  it("replays the same scrollback to a second attachment", () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("xyz");
    expect(table.attach(ptyId).ack.scrollback).toEqual(["xyz"]);
    expect(table.attach(ptyId).ack.scrollback).toEqual(["xyz"]);
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
