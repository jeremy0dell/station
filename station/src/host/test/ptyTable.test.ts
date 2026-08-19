import type { HostPtyRef, HostSpawnParams } from "@station/host";
import { describe, expect, it } from "bun:test";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../../terminal/types.js";
import { createScriptedTerminal, type ScriptedTerminal } from "../../terminal/testing/scriptedTerminal.js";
import { createPtyTable } from "../ptyTable.js";
import {
  type SemanticTerminalModel,
  TerminalSnapshotPendingError,
  TerminalSnapshotUnavailableError,
} from "../semanticTerminalSnapshot.js";

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

function liveRef(table: ReturnType<typeof createPtyTable>, ptyId: string) {
  const entry = table.list().find((candidate) => candidate.ptyId === ptyId);
  if (entry === undefined) throw new Error(`missing live PTY ${ptyId}`);
  return entry;
}

let attachmentSequence = 0;
function attach(
  table: ReturnType<typeof createPtyTable>,
  ptyRef: HostPtyRef,
  intent: "controller" | "viewer" = "viewer",
) {
  attachmentSequence += 1;
  return table.attach(ptyRef, `att-test-${attachmentSequence}`, intent);
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
      rawChunks: ["hello ", "world"],
      rawComplete: true,
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
    const attachment = await attach(table, liveRef(table, ptyId));
    const iterator = attachment.frames[Symbol.asyncIterator]();
    const input = "\x1b[1;50r\x1b[3S\x1b[r\x1b[48;1H\x1b[J";
    const expected = "\x1b[r\x1b[999;1H\n\n\n\x1b[H\x1b[48;1H\x1b[J";

    scripted.helpers.emitData(input);
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "data", ptyId, data: expected },
    });
    expect(table.snapshot(ptyId).rawChunks).toEqual([expected]);

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

    expect(table.snapshot(ptyId).rawChunks).toEqual([input]);
  });

  it("flushes an incomplete compatibility prefix before the exit frame", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn({
      ...baseParams,
      outputCompatibility: "top-region-scrollback",
    });
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    const iterator = controller.frames[Symbol.asyncIterator]();
    const partial = "before\x1b[1;23r\x1b[";

    scripted.helpers.emitData(partial);
    const closing = table.close(ptyId);
    scripted.helpers.emitExit({ exitCode: 0 });
    await closing;

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
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    const iterator = controller.frames[Symbol.asyncIterator]();
    const partial = "before\x1b[1;23r\x1b[";

    scripted.helpers.emitData(partial);
    controller.resize(controller.controlState.controlEpoch, 100, 30);

    expect(await iterator.next()).toMatchObject({ value: { type: "data", data: "before" } });
    expect(await iterator.next()).toMatchObject({
      value: { type: "data", data: "\x1b[1;23r\x1b[" },
    });
    expect(await iterator.next()).toMatchObject({
      value: { type: "resize", cols: 100, rows: 30 },
    });
    expect((await attach(table, liveRef(table, ptyId))).ack.replay.events).toEqual([
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
    expect(snapshot.rawChunks).toHaveLength(256);
    expect(snapshot.rawChunks.every((entry) => entry === chunk)).toBe(true);
    expect(snapshot.rawComplete).toBe(false);
  });

  it("uses semantic recovery after truncation and never returns partial raw bytes", async () => {
    const { table, scripted } = (() => {
      const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
      const semantic: SemanticTerminalModel = {
        write() {},
        resize() {},
        capture: async () => ["semantic-state"],
        dispose() {},
      };
      return {
        scripted,
        table: createPtyTable({
          createTerminal: () => scripted.terminal,
          createSemanticTerminal: () => semantic,
          maxScrollbackBytes: 5,
        }),
      };
    })();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("first");
    scripted.helpers.emitData("second");

    expect((await attach(table, liveRef(table, ptyId))).ack.replay).toEqual({
      kind: "semantic-truncation-recovery",
      initialCols: 80,
      initialRows: 24,
      events: [{ type: "data", data: "semantic-state" }],
    });
  });

  it("captures behind a registered sink so boundary output is delivered once as live data", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const capture = Promise.withResolvers<string[]>();
    const operations: string[] = [];
    const semantic: SemanticTerminalModel = {
      write(data) {
        operations.push(`write:${data}`);
      },
      resize(cols, rows) {
        operations.push(`resize:${cols}x${rows}`);
      },
      capture: () => {
        operations.push("capture");
        return capture.promise;
      },
      dispose() {},
    };
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      createSemanticTerminal: () => semantic,
      maxScrollbackBytes: 5,
    });
    const { ptyId } = table.spawn(baseParams);
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    scripted.helpers.emitData("before");
    scripted.helpers.emitData("truncate");

    const attaching = attach(table, liveRef(table, ptyId));
    scripted.helpers.emitData("during");
    controller.resize(controller.controlState.controlEpoch, 100, 30);
    capture.resolve(["snapshot-at-boundary"]);
    const attached = await attaching;
    const frames = attached.frames[Symbol.asyncIterator]();

    expect(attached.ack).toMatchObject({
      cols: 80,
      rows: 24,
      replay: {
        kind: "semantic-truncation-recovery",
        initialCols: 80,
        initialRows: 24,
        events: [{ type: "data", data: "snapshot-at-boundary" }],
      },
    });
    expect(await frames.next()).toMatchObject({ value: { type: "data", data: "during" } });
    expect(await frames.next()).toMatchObject({
      value: { type: "resize", cols: 100, rows: 30 },
    });
    expect(operations).toEqual([
      "write:before",
      "write:truncate",
      "capture",
      "write:during",
      "resize:100x30",
    ]);
    await frames.return?.();
  });

  it("keeps the live sink and reports boundary reset data when exact capture is unavailable", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const resetData = "\x1bc\x1b[?1h\x1b[?2004h";
    const semantic: SemanticTerminalModel = {
      write() {},
      resize() {},
      capture: async () => {
        throw new TerminalSnapshotUnavailableError(
          { reason: "serialization-failed" },
          resetData,
          "Could not serialize the semantic terminal model.",
        );
      },
      dispose() {},
    };
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      createSemanticTerminal: () => semantic,
      maxScrollbackBytes: 5,
      onEvent: (event, attributes) => events.push({ event, attributes }),
    });
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("first");
    scripted.helpers.emitData("second");

    const degraded = await attach(table, liveRef(table, ptyId));
    expect(degraded.ack.replay).toEqual({
      kind: "live-reset-recovery",
      initialCols: 80,
      initialRows: 24,
      events: [],
      resetData,
    });
    expect(events.find(({ event }) => event === "pty.snapshot.degraded")).toEqual({
      event: "pty.snapshot.degraded",
      attributes: { ptyId, reason: "serialization-failed" },
    });
    expect(table.list()).toMatchObject([{ ptyId, alive: true }]);
    expect(table.has(ptyId)).toBe(true);
    const frames = degraded.frames[Symbol.asyncIterator]();
    scripted.helpers.emitData("live-after-reset");
    expect(await frames.next()).toMatchObject({
      value: { type: "data", data: "live-after-reset" },
    });
    await frames.return?.();
  });

  it("logs a safe cell-attribute subtype while preserving live-reset recovery", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const events: Array<{ event: string; attributes: Record<string, unknown> }> = [];
    const resetData = "\x1bc\x1b[?2004h";
    const semantic: SemanticTerminalModel = {
      write() {},
      resize() {},
      capture: async () => {
        throw new TerminalSnapshotUnavailableError(
          { reason: "unsupported-state", detail: "cell-underline-color" },
          resetData,
          "unsafe terminal context stays provider-private",
        );
      },
      dispose() {},
    };
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      createSemanticTerminal: () => semantic,
      maxScrollbackBytes: 5,
      onEvent: (event, attributes) => events.push({ event, attributes }),
    });
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("first");
    scripted.helpers.emitData("second");

    const attachment = await attach(table, liveRef(table, ptyId));
    expect(attachment.ack.replay).toEqual({
      kind: "live-reset-recovery",
      initialCols: 80,
      initialRows: 24,
      events: [],
      resetData,
    });
    expect(events.find(({ event }) => event === "pty.snapshot.degraded")).toEqual({
      event: "pty.snapshot.degraded",
      attributes: {
        ptyId,
        reason: "unsupported-state",
        detail: "cell-underline-color",
      },
    });
  });

  it("classifies an unfinished parser sequence as retryable snapshot state", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const semantic: SemanticTerminalModel = {
      write() {},
      resize() {},
      capture: async () => {
        throw new TerminalSnapshotPendingError("parser sequence is unfinished");
      },
      dispose() {},
    };
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      createSemanticTerminal: () => semantic,
      maxScrollbackBytes: 5,
    });
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("first");
    scripted.helpers.emitData("second");

    await expect(attach(table, liveRef(table, ptyId))).rejects.toMatchObject({ code: "HOST_SNAPSHOT_PENDING" });
    expect(table.has(ptyId)).toBe(true);
  });

  it("reuses the live PTY for the same worktree (idempotent spawn)", () => {
    const { table, scripteds } = tableWithScripted();
    const first = table.spawn(baseParams);
    const second = table.spawn(baseParams);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(scripteds).toHaveLength(1);
    expect(table.list()).toHaveLength(1);
  });

  it("refuses every immutable identity disagreement before spawning", () => {
    const conflicts: Array<Partial<HostSpawnParams>> = [
      { kind: "aux" },
      { worktreeId: "wt-replacement" },
      { projectId: "proj-replacement" },
      { sessionId: "ses-replacement" },
      { worktreePath: "/repo/replacement" },
      { harnessProvider: "codex" },
    ];
    const { table, scripteds } = tableWithScripted();
    const first = table.spawn(baseParams);

    for (const conflict of conflicts) {
      expect(() => table.spawn({ ...baseParams, ...conflict })).toThrow();
    }
    expect(scripteds).toHaveLength(1);
    expect(table.list()).toMatchObject([{ ptyId: first.ptyId, sessionId: baseParams.sessionId }]);
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

    expect(first).toMatchObject({ terminalTargetId: "native:wt-1", ptyId: "pty-1", pid: 4200, created: true });
    expect(second).toMatchObject({ terminalTargetId: "native:wt-2", ptyId: "pty-2", pid: 4201, created: true });
    expect(scripteds).toHaveLength(2);
    expect(table.list().map((entry) => [entry.terminalTargetId, entry.ptyId, entry.pid])).toEqual([
      ["native:wt-1", "pty-1", 4200],
      ["native:wt-2", "pty-2", 4201],
    ]);
  });

  it("rolls back both indexes and resources when spawn activation fails", () => {
    const failed = createScriptedTerminal({ cols: 80, rows: 24 });
    const replacement = createScriptedTerminal({ cols: 80, rows: 24 });
    let created = 0;
    let semanticDisposals = 0;
    const table = createPtyTable({
      createTerminal: () => {
        created += 1;
        if (created === 1) {
          return {
            ...failed.terminal,
            onExit() {
              throw new Error("subscription failed");
            },
          };
        }
        return replacement.terminal;
      },
      createSemanticTerminal: () => ({
        write() {},
        resize() {},
        capture: async () => [],
        dispose() {
          semanticDisposals += 1;
        },
      }),
    });

    let failure: unknown;
    try {
      table.spawn(baseParams);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "HOST_SPAWN_FAILED" });
    expect(table.list()).toEqual([]);
    expect(failed.helpers.isDisposed()).toBe(true);
    expect(semanticDisposals).toBe(1);

    expect(table.spawn(baseParams)).toMatchObject({ created: true });
    expect(table.list()).toHaveLength(1);
    table.disposeAll();
  });

  it("forwards controller writes and clamped resizes to the terminal", async () => {
    const { table, scripteds } = tableWithScripted();
    const { ptyId } = table.spawn(baseParams);
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    controller.write(controller.controlState.controlEpoch, "ls\n");
    controller.resize(controller.controlState.controlEpoch, 1, 0); // below MIN_COLS/MIN_ROWS — clamps to 2x1
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
    let dataSubscriptionDisposed = false;
    let exitSubscriptionDisposed = false;
    const terminal: StationTerminalProcess = {
      id: "immediate",
      command: "true",
      pid: 42,
      size: { cols: 80, rows: 24 },
      onData(listener) {
        listener("complete");
        return {
          dispose() {
            dataSubscriptionDisposed = true;
          },
        };
      },
      onExit(listener) {
        listener({ exitCode: 0 });
        return {
          dispose() {
            exitSubscriptionDisposed = true;
          },
        };
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
    expect(dataSubscriptionDisposed).toBe(true);
    expect(exitSubscriptionDisposed).toBe(true);
    expect(events).toEqual(["agent.spawn", "agent.exit"]);
  });

  it("does not accumulate a duplicate target when a worktree's PTY exits then relaunches", () => {
    const { table, scripteds } = tableWithScripted();
    const first = table.spawn(baseParams);
    scripteds[0]?.helpers.emitExit({ exitCode: 0 }); // reaped
    const again = table.spawn(baseParams); // relaunch same worktree
    expect(again.ptyId).toBe("pty-2");
    expect(again.ptyInstanceId).not.toBe(first.ptyInstanceId);
    expect(table.list().map((entry) => entry.ptyId)).toEqual(["pty-2"]); // one, not two
  });

  it("attach acks an atomic scrollback snapshot, then streams live frames", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("before-"); // lands in the ring (snapshot)

    const { ack, frames } = await attach(table, liveRef(table, ptyId));
    expect(ack).toMatchObject({
      kind: baseParams.kind,
      terminalTargetId: baseParams.terminalTargetId,
      worktreeId: baseParams.worktreeId,
      projectId: baseParams.projectId,
      sessionId: baseParams.sessionId,
      worktreePath: baseParams.worktreePath,
      harnessProvider: baseParams.harnessProvider,
      ptyId,
      exited: false,
      replay: {
        kind: "raw-complete",
        initialCols: 80,
        initialRows: 24,
        events: [{ type: "data", data: "before-" }],
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

  it("rejects target, PTY-id, and instance mismatches before creating an attachment", async () => {
    const { table } = singleTable();
    const spawned = table.spawn(baseParams);
    const mismatches = [
      { ...spawned, terminalTargetId: "native:stale-target" },
      { ...spawned, ptyId: "pty-stale" },
      { ...spawned, ptyInstanceId: "instance-stale" },
    ];

    for (const mismatch of mismatches) {
      await expect(attach(table, mismatch)).rejects.toMatchObject({
        code: "HOST_ATTACHMENT_MISMATCH",
      });
    }
  });

  it("rejects a duplicate Host-issued attachment identity without replacing its stream", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const ref = liveRef(table, ptyId);
    const first = await table.attach(ref, "att-duplicate", "viewer");

    await expect(table.attach(ref, "att-duplicate", "viewer")).rejects.toMatchObject({
      code: "HOST_ATTACHMENT_MISMATCH",
    });
    const next = first.frames[Symbol.asyncIterator]().next();
    scripted.helpers.emitData("still-attached");
    await expect(next).resolves.toMatchObject({ value: { data: "still-attached" } });
  });

  it("orders live data around the resize barrier applied by the Host", async () => {
    const scripted = createScriptedTerminal({ cols: 10, rows: 4 });
    const table = createPtyTable({ createTerminal: () => scripted.terminal });
    const { ptyId } = table.spawn({ ...baseParams, cols: 10, rows: 4 });
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    const iterator = controller.frames[Symbol.asyncIterator]();

    scripted.helpers.emitData("before-resize");
    controller.resize(controller.controlState.controlEpoch, 5, 4);
    scripted.helpers.emitData("after-resize");

    const frames = await Promise.all([iterator.next(), iterator.next(), iterator.next()]);
    expect(frames.map(({ value }) => value)).toEqual([
      { type: "data", ptyId, data: "before-resize" },
      { type: "resize", ptyId, cols: 5, rows: 4 },
      { type: "data", ptyId, data: "after-resize" },
    ]);
    expect((await attach(table, liveRef(table, ptyId))).ack.replay).toEqual({
      kind: "raw-complete",
      initialCols: 10,
      initialRows: 4,
      events: [
        { type: "data", data: "before-resize" },
        { type: "resize", cols: 5, rows: 4 },
        { type: "data", data: "after-resize" },
      ],
    });
    await iterator.return?.();
  });

  it("preserves a resize-only round trip in complete raw replay", async () => {
    const scripted = createScriptedTerminal({ cols: 10, rows: 4 });
    const table = createPtyTable({ createTerminal: () => scripted.terminal });
    const { ptyId } = table.spawn({ ...baseParams, cols: 10, rows: 4 });
    const controller = await attach(table, liveRef(table, ptyId), "controller");

    scripted.helpers.emitData("1234567890abcdefghij");
    controller.resize(controller.controlState.controlEpoch, 5, 4);
    controller.resize(controller.controlState.controlEpoch, 10, 4);

    expect((await attach(table, liveRef(table, ptyId))).ack.replay).toEqual({
      kind: "raw-complete",
      initialCols: 10,
      initialRows: 4,
      events: [
        { type: "data", data: "1234567890abcdefghij" },
        { type: "resize", cols: 5, rows: 4 },
        { type: "resize", cols: 10, rows: 4 },
      ],
    });
  });

  it("replays the same complete raw stream to a second attachment", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    scripted.helpers.emitData("xyz");
    expect((await attach(table, liveRef(table, ptyId))).ack.replay).toEqual({
      kind: "raw-complete",
      initialCols: 80,
      initialRows: 24,
      events: [{ type: "data", data: "xyz" }],
    });
    expect((await attach(table, liveRef(table, ptyId))).ack.replay).toEqual({
      kind: "raw-complete",
      initialCols: 80,
      initialRows: 24,
      events: [{ type: "data", data: "xyz" }],
    });
  });

  it("grants one controller, atomically revokes it on takeover, and rejects stale mutations", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const first = await attach(table, liveRef(table, ptyId), "controller");
    const viewer = await attach(table, liveRef(table, ptyId));
    const firstFrames = first.frames[Symbol.asyncIterator]();

    expect(first.controlState).toMatchObject({ role: "controller", controlEpoch: 1 });
    expect(viewer.controlState).toMatchObject({ role: "viewer", controlEpoch: 1 });
    expect(() => viewer.resize(viewer.controlState.controlEpoch, 40, 10)).toThrow();
    expect(scripted.helpers.resizes).toEqual([]);

    expect(viewer.claimControl()).toMatchObject({ role: "controller", controlEpoch: 2 });
    expect(await firstFrames.next()).toMatchObject({
      value: {
        type: "control-revoked",
        attachmentId: first.ack.attachmentId,
        controlEpoch: 2,
      },
    });
    expect(first.controlState).toMatchObject({ role: "viewer", controlEpoch: 2 });
    expect(() =>
      first.write(1, "stale"),
    ).toThrow();
    expect(scripted.helpers.writes).toEqual([]);

    viewer.write(viewer.controlState.controlEpoch, "accepted");
    expect(scripted.helpers.writes).toEqual(["accepted"]);
    expect(viewer.claimControl()).toEqual(viewer.controlState);
    expect(viewer.controlState.controlEpoch).toBe(2);
  });

  it("releases controller authority on detach without promoting a viewer", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const controller = await attach(table, liveRef(table, ptyId), "controller");
    const viewer = await attach(table, liveRef(table, ptyId));

    await controller.frames[Symbol.asyncIterator]().return?.();
    expect(() => viewer.write(viewer.controlState.controlEpoch, "not-promoted")).toThrow();
    expect(scripted.helpers.writes).toEqual([]);
    expect(viewer.claimControl()).toMatchObject({ role: "controller", controlEpoch: 2 });
  });

  it("broadcasts data and exit to every attachment, then ends each stream", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const a = (await attach(table, liveRef(table, ptyId))).frames[Symbol.asyncIterator]();
    const b = (await attach(table, liveRef(table, ptyId))).frames[Symbol.asyncIterator]();

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
    await (await attach(table, liveRef(table, ptyId))).frames[Symbol.asyncIterator]().return?.();
    expect(table.list()[0]).toMatchObject({ ptyId, alive: true });
    expect(scripted.helpers.isDisposed()).toBe(false);
  });

  it("close kills the PTY, broadcasts exit to attachments, and drops it from the table", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const frames = (await attach(table, liveRef(table, ptyId))).frames[Symbol.asyncIterator]();

    let closeSettled = false;
    const closing = table.close(ptyId).then((closed) => {
      closeSettled = true;
      return closed;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(scripted.helpers.isDisposed()).toBe(false);
    expect(table.list()).toHaveLength(1);

    scripted.helpers.emitExit({ exitCode: 0 });
    expect(await closing).toBe(true);
    expect(scripted.helpers.isDisposed()).toBe(true);
    expect(table.list()).toEqual([]);
    expect(await frames.next()).toMatchObject({ value: { type: "exit", ptyId } });
    // Idempotent: closing an unknown PTY is a no-op.
    expect(await table.close(ptyId)).toBe(false);
  });

  it("close fails closed when the process never emits exit", async () => {
    const scripted = createScriptedTerminal({ cols: 80, rows: 24 });
    const table = createPtyTable({
      createTerminal: () => scripted.terminal,
      closeTimeoutMs: 1,
    });
    const { ptyId } = table.spawn(baseParams);

    await expect(table.close(ptyId)).rejects.toMatchObject({ code: "HOST_PTY_CLOSE_TIMEOUT" });
    expect(table.list()).toHaveLength(1);
    expect(scripted.helpers.isDisposed()).toBe(false);
    scripted.helpers.emitExit({ exitCode: 0 });
  });

  it("disposeAll broadcasts exit to attachments so streams end (no hang on shutdown)", async () => {
    const { table, scripted } = singleTable();
    const { ptyId } = table.spawn(baseParams);
    const frames = (await attach(table, liveRef(table, ptyId))).frames[Symbol.asyncIterator]();
    table.disposeAll();
    expect(scripted.helpers.isDisposed()).toBe(true);
    expect(await frames.next()).toMatchObject({ value: { type: "exit", ptyId } });
    expect(await frames.next()).toEqual({ done: true, value: undefined });
  });

  it("attaching after a PTY has exited (and been reaped) is HOST_ATTACH_GONE", async () => {
    const { table, scripted } = singleTable();
    const spawned = table.spawn(baseParams);
    scripted.helpers.emitData("done");
    scripted.helpers.emitExit({ exitCode: 3 }); // reaped
    await expect(attach(table, spawned)).rejects.toMatchObject({ code: "HOST_ATTACH_GONE" });
  });
});
