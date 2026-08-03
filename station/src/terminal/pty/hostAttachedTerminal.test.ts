import {
  type HostAttachAck,
  type HostAttachment,
  type HostFrame,
  type StationHostClient,
  StationHostProviderError,
} from "@station/host";
import { describe, expect, it } from "bun:test";
import {
  resetTerminalDiagnosticsForTest,
  terminalCorruptionCounters,
} from "../diagnostics.js";
import type {
  StationTerminalDisposable,
  StationTerminalProcess,
  StationTerminalReplay,
  StationTerminalSize,
} from "../types.js";
import { createHostAttachedTerminal, RECONNECT_REPAINT } from "./hostAttachedTerminal.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type ControllableAttachmentBehavior = {
  write?: (data: string) => Promise<void>;
  resize?: (cols: number, rows: number) => Promise<void>;
};

function controllableAttachment(
  ack: HostAttachAck,
  behavior: ControllableAttachmentBehavior = {},
) {
  const queue: HostFrame[] = [];
  const waiters: Array<(r: IteratorResult<HostFrame>) => void> = [];
  let ended = false;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let detached = false;
  const drain = () => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      const next = queue.shift();
      waiter(next === undefined ? { done: true, value: undefined } : { done: false, value: next });
    }
  };
  const attachment: HostAttachment = {
    attachmentId: "att-test",
    ack,
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<HostFrame>>((resolve) => {
            const next = queue.shift();
            if (next !== undefined) resolve({ done: false, value: next });
            else if (ended) resolve({ done: true, value: undefined });
            else waiters.push(resolve);
          }),
        return: () => {
          ended = true;
          drain();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    },
    write: async (data) => {
      writes.push(data);
      await behavior.write?.(data);
    },
    resize: async (cols, rows) => {
      resizes.push({ cols, rows });
      await behavior.resize?.(cols, rows);
    },
    detach: async () => {
      detached = true;
      ended = true;
      drain();
    },
  };
  return {
    attachment,
    push: (frame: HostFrame) => {
      queue.push(frame);
      drain();
    },
    // Simulate a socket drop: the frame stream ends with no exit frame.
    endStream: () => {
      ended = true;
      drain();
    },
    state: { writes, resizes, isDetached: () => detached },
  };
}

type AckOverrides = Omit<Partial<HostAttachAck>, "replay"> & {
  replay?: HostAttachAck["replay"];
  scrollback?: readonly string[];
};

function ack(overrides: AckOverrides = {}): HostAttachAck {
  const { replay, scrollback = [], ...fields } = overrides;
  const cols = fields.cols ?? 80;
  const rows = fields.rows ?? 24;
  return {
    subscribed: true,
    ptyId: "pty-1",
    pid: 4242,
    cols,
    rows,
    exited: false,
    ...fields,
    replay: replay ?? {
      kind: "raw-complete",
      initialCols: cols,
      initialRows: rows,
      events: scrollback.map((data) => ({ type: "data" as const, data })),
    },
  };
}

function clientForAttach(
  attach: StationHostClient["attach"],
  dispose: () => void = () => {},
): StationHostClient {
  return {
    attach,
    dispose,
    health: async () => ({ ok: true, protocolVersion: 1 }),
    stopIfIdle: async () => ({ stopping: true }),
    spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
    write: async () => undefined,
    resize: async () => undefined,
    list: async () => [],
    focus: async () => undefined,
    close: async () => ({ closed: true }),
  };
}

function terminalFor(
  attachment: HostAttachment,
  size: StationTerminalSize = { cols: 80, rows: 24 },
) {
  let clientDisposed = false;
  const terminal = createHostAttachedTerminal({
    hostSocketPath: "/tmp/unused.sock",
    ptyId: "pty-1",
    size,
    clientFactory: () =>
      clientForAttach(async () => attachment, () => {
        clientDisposed = true;
      }),
  });
  return { terminal, clientDisposed: () => clientDisposed };
}

describe("createHostAttachedTerminal", () => {
  it("replays the scrollback snapshot through onData, then streams live frames", async () => {
    const ctrl = controllableAttachment(ack({ scrollback: ["scroll-"] }));
    const { terminal } = terminalFor(ctrl.attachment);
    const received: string[] = [];
    terminal.onData((data) => received.push(data));

    await flush(); // let attach resolve + replay the snapshot
    expect(received).toEqual(["scroll-"]);

    ctrl.push({ type: "data", ptyId: "pty-1", data: "live" });
    await flush();
    expect(received).toEqual(["scroll-", "live"]);
    expect(terminal.pid).toBe(4242);
  });

  it("delivers ordered replay in one awaited callback before live frames", async () => {
    const replay: StationTerminalReplay = {
      kind: "raw-complete",
      initialSize: { cols: 10, rows: 4 },
      events: [
        { type: "data", data: "before" },
        { type: "resize", cols: 5, rows: 4 },
        { type: "data", data: "after" },
        { type: "resize", cols: 10, rows: 4 },
      ],
    };
    const ctrl = controllableAttachment(
      ack({
        cols: 10,
        rows: 4,
        replay: {
          kind: "raw-complete",
          initialCols: replay.initialSize.cols,
          initialRows: replay.initialSize.rows,
          events: [...replay.events],
        },
      }),
    );
    const { terminal } = terminalFor(ctrl.attachment, { cols: 5, rows: 4 });
    const replayGate = deferred<void>();
    const receivedReplays: StationTerminalReplay[] = [];
    const receivedData: string[] = [];
    terminal.onReplay?.(async (received) => {
      receivedReplays.push(received);
      await replayGate.promise;
    });
    terminal.onData((data) => receivedData.push(data));

    try {
      await flush();
      ctrl.push({ type: "data", ptyId: "pty-1", data: "live" });
      expect(receivedReplays).toEqual([replay]);
      expect(receivedData).toEqual([]);
      expect(ctrl.state.resizes).toEqual([]);

      replayGate.resolve(undefined);
      await flush();
      expect(receivedData).toEqual(["live"]);
      expect(ctrl.state.resizes).toEqual([{ cols: 5, rows: 4 }]);
    } finally {
      replayGate.resolve(undefined);
      terminal.dispose();
    }
  });

  it("buffers writes/resizes before attach resolves, then flushes them", async () => {
    const ctrl = controllableAttachment(ack());
    const { terminal } = terminalFor(ctrl.attachment);
    terminal.write("pre");
    terminal.resize({ cols: 100, rows: 30 });
    await flush();
    expect(ctrl.state.writes).toEqual(["pre"]);
    expect(ctrl.state.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("does not acknowledge requested geometry until its ordered resize frame is consumed", async () => {
    const ctrl = controllableAttachment(ack({ cols: 10, rows: 4 }));
    const { terminal } = terminalFor(ctrl.attachment, { cols: 5, rows: 4 });
    try {
      await flush();
      await flush();

      expect(ctrl.state.resizes).toEqual([{ cols: 5, rows: 4 }]);
      expect(terminal.ackedSize).not.toEqual({ cols: 5, rows: 4 });

      ctrl.push({
        type: "resize",
        ptyId: "pty-1",
        cols: 5,
        rows: 4,
      } as unknown as HostFrame);
      await flush();

      expect(terminal.ackedSize).toEqual({ cols: 5, rows: 4 });
    } finally {
      terminal.dispose();
    }
  });

  it("awaits ordered geometry listeners before delivering post-barrier data", async () => {
    const ctrl = controllableAttachment(ack({ cols: 10, rows: 4, scrollback: ["snapshot"] }));
    const { terminal } = terminalFor(ctrl.attachment, { cols: 5, rows: 4 });
    const geometryGate = deferred<void>();
    const events: string[] = [];
    terminal.onReplay?.(({ initialSize }) => {
      events.push(`replay:${initialSize.cols}x${initialSize.rows}`);
    });
    terminal.onData((data) => events.push(`data:${data}`));
    const ordered = terminal as StationTerminalProcess & {
      onGeometry?: (
        listener: (size: StationTerminalSize) => void | Promise<void>,
      ) => StationTerminalDisposable;
    };
    ordered.onGeometry?.(async (size) => {
      events.push(`geometry:${size.cols}x${size.rows}`);
      await geometryGate.promise;
    });

    try {
      await flush();
      ctrl.push({ type: "data", ptyId: "pty-1", data: "before" });
      ctrl.push({
        type: "resize",
        ptyId: "pty-1",
        cols: 5,
        rows: 4,
      } as unknown as HostFrame);
      ctrl.push({ type: "data", ptyId: "pty-1", data: "after" });
      await flush();

      expect(events).toEqual(["replay:10x4", "data:before", "geometry:5x4"]);
      expect(terminal.ackedSize).toEqual({ cols: 5, rows: 4 });

      geometryGate.resolve(undefined);
      await flush();
      expect(events).toEqual([
        "replay:10x4",
        "data:before",
        "geometry:5x4",
        "data:after",
      ]);
    } finally {
      geometryGate.resolve(undefined);
      terminal.dispose();
    }
  });

  it("resends a resize that lands during initial geometry synchronization", async () => {
    const initialResize = deferred<void>();
    const initialResizeStarted = deferred<void>();
    let blockInitialResize = true;
    const ctrl = controllableAttachment(ack(), {
      resize: async () => {
        if (!blockInitialResize) {
          return;
        }
        blockInitialResize = false;
        initialResizeStarted.resolve(undefined);
        await initialResize.promise;
      },
    });
    const { terminal } = terminalFor(ctrl.attachment);

    await initialResizeStarted.promise;
    terminal.resize({ cols: 100, rows: 30 });
    initialResize.resolve(undefined);
    await flush();
    await flush();

    expect(ctrl.state.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    ]);
    expect(terminal.ackedSize).toBeUndefined();
    ctrl.push({ type: "resize", ptyId: "pty-1", cols: 100, rows: 30 });
    await flush();
    expect(terminal.ackedSize).toEqual({ cols: 100, rows: 30 });
    terminal.dispose();
  });

  it("resends a resize that lands during the same-size repaint restore", async () => {
    const restoreResize = deferred<void>();
    const restoreResizeStarted = deferred<void>();
    let resizeCalls = 0;
    const ctrl = controllableAttachment(ack({ scrollback: ["history"] }), {
      resize: async () => {
        resizeCalls += 1;
        if (resizeCalls === 3) {
          restoreResizeStarted.resolve(undefined);
          await restoreResize.promise;
        }
      },
    });
    const { terminal } = terminalFor(ctrl.attachment);

    await restoreResizeStarted.promise;
    terminal.resize({ cols: 100, rows: 30 });
    restoreResize.resolve(undefined);
    await flush();
    await flush();

    expect(ctrl.state.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 23 },
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    ]);
    expect(terminal.ackedSize).toBeUndefined();
    ctrl.push({ type: "resize", ptyId: "pty-1", cols: 100, rows: 30 });
    await flush();
    expect(terminal.ackedSize).toEqual({ cols: 100, rows: 30 });
    terminal.dispose();
  });

  it("surfaces an exit frame through onExit", async () => {
    const ctrl = controllableAttachment(ack());
    const { terminal } = terminalFor(ctrl.attachment);
    const exits: number[] = [];
    terminal.onExit((event) => exits.push(event.exitCode));
    await flush();
    ctrl.push({ type: "exit", ptyId: "pty-1", exitCode: 3 });
    await flush();
    expect(exits).toEqual([3]);
  });

  it("dispose closes the connection (host detaches via socket-close; never kills)", async () => {
    const ctrl = controllableAttachment(ack());
    const { terminal, clientDisposed } = terminalFor(ctrl.attachment);
    await flush();
    terminal.dispose();
    expect(clientDisposed()).toBe(true);
  });

  it("stops before replay or activation when dispose races attach resolution", async () => {
    const ctrl = controllableAttachment(ack({ scrollback: ["history"] }));
    const pendingAttach = deferred<HostAttachment>();
    let clientDisposed = false;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        clientForAttach(async () => pendingAttach.promise, () => {
          clientDisposed = true;
        }),
    });
    const received: string[] = [];
    terminal.onData((data) => received.push(data));

    terminal.dispose();
    pendingAttach.resolve(ctrl.attachment);
    await flush();

    expect(clientDisposed).toBe(true);
    expect(received).toEqual([]);
    expect(ctrl.state.resizes).toEqual([]);
    expect(ctrl.state.writes).toEqual([]);
  });

  it("stops activation when dispose lands during replay", async () => {
    const replayGate = deferred<void>();
    const ctrl = controllableAttachment(ack({ scrollback: ["history"] }));
    const { terminal } = terminalFor(ctrl.attachment);
    let replayStarted = false;
    terminal.onReplay?.(async () => {
      replayStarted = true;
      await replayGate.promise;
    });

    await flush();
    expect(replayStarted).toBe(true);
    terminal.dispose();
    replayGate.resolve(undefined);
    await flush();

    expect(ctrl.state.resizes).toEqual([]);
    expect(ctrl.state.writes).toEqual([]);
  });

  it("treats an exited attach acknowledgement as terminal without retrying", async () => {
    const ctrl = controllableAttachment(ack({ exited: true, scrollback: ["stale"] }));
    let attachCalls = 0;
    const sleeps: number[] = [];
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        clientForAttach(async () => {
          attachCalls += 1;
          return ctrl.attachment;
        }),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const diagnostics: string[] = [];
    const exits: number[] = [];
    terminal.onDiagnostic((message) => diagnostics.push(message));
    terminal.onExit((event) => exits.push(event.exitCode));

    await flush();

    expect(attachCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(diagnostics).toEqual(["Station host PTY already exited."]);
    expect(exits).toEqual([1]);
    expect(ctrl.state.resizes).toEqual([]);
  });
});

type Tracking = { spawns: unknown[]; closes: string[]; spawnPtyId: string };

function trackingClientFactory(attachment: HostAttachment, tracking: Tracking) {
  return () =>
    ({
      attach: async () => attachment,
      dispose: () => {},
      health: async () => ({ ok: true, protocolVersion: 1 }),
      stopIfIdle: async () => ({ stopping: true }),
      spawn: async (params: unknown) => {
        tracking.spawns.push(params);
        return { ptyId: tracking.spawnPtyId, pid: 4242 };
      },
      write: async () => undefined,
      resize: async () => undefined,
      list: async () => [],
      focus: async () => undefined,
      close: async (ptyId: string) => {
        tracking.closes.push(ptyId);
        return { closed: true };
      },
    }) satisfies StationHostClient;
}

const auxSpawn = {
  kind: "aux" as const,
  terminalTargetId: "aux:pane-split-0",
  worktreeId: "aux",
  projectId: "aux",
  sessionId: "aux:pane-split-0",
  worktreePath: "/work",
  harnessProvider: "aux",
  command: "bash",
  args: [] as string[],
  cwd: "/work",
  cols: 80,
  rows: 24,
};

describe("createHostAttachedTerminal (Station-owned aux)", () => {
  it("spawn mode: spawns a host PTY at the laid-out size, then attaches to it", async () => {
    const ctrl = controllableAttachment(ack({ ptyId: "pty-spawned" }));
    const tracking: Tracking = { spawns: [], closes: [], spawnPtyId: "pty-spawned" };
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      size: { cols: 120, rows: 40 },
      spawn: auxSpawn,
      clientFactory: trackingClientFactory(ctrl.attachment, tracking),
    });
    await flush();
    expect(tracking.spawns).toHaveLength(1);
    const params = tracking.spawns[0] as typeof auxSpawn;
    expect(params.kind).toBe("aux");
    expect(params.terminalTargetId).toBe("aux:pane-split-0");
    // The laid-out size overrides the placeholder cols/rows in the descriptor.
    expect(params.cols).toBe(120);
    expect(params.rows).toBe(40);
    expect(terminal.pid).toBe(4242);
  });

  it("kill() closes an owned (spawned) aux PTY on the host", async () => {
    const ctrl = controllableAttachment(ack({ ptyId: "pty-spawned" }));
    const tracking: Tracking = { spawns: [], closes: [], spawnPtyId: "pty-spawned" };
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      size: { cols: 80, rows: 24 },
      spawn: auxSpawn,
      clientFactory: trackingClientFactory(ctrl.attachment, tracking),
    });
    await flush();
    terminal.kill();
    await flush();
    expect(tracking.closes).toEqual(["pty-spawned"]);
  });

  it("kill() closes an owned REATTACH (owned:true) PTY on the host", async () => {
    const ctrl = controllableAttachment(ack({ ptyId: "pty-reattach" }));
    const tracking: Tracking = { spawns: [], closes: [], spawnPtyId: "unused" };
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-reattach",
      owned: true,
      size: { cols: 80, rows: 24 },
      clientFactory: trackingClientFactory(ctrl.attachment, tracking),
    });
    await flush();
    terminal.kill();
    await flush();
    expect(tracking.closes).toEqual(["pty-reattach"]);
  });

  it("reports an owned PTY close failure after immediate pane disposal", async () => {
    resetTerminalDiagnosticsForTest();
    try {
      const ctrl = controllableAttachment(ack({ ptyId: "pty-close-failure" }));
      let clientCreations = 0;
      let closerDisposed = false;
      const terminal = createHostAttachedTerminal({
        hostSocketPath: "/tmp/x.sock",
        ptyId: "pty-close-failure",
        owned: true,
        size: { cols: 80, rows: 24 },
        clientFactory: () => {
          clientCreations += 1;
          if (clientCreations === 1) {
            return clientForAttach(async () => ctrl.attachment);
          }
          return {
            ...clientForAttach(async () => ctrl.attachment, () => {
              closerDisposed = true;
            }),
            close: async () => {
              throw new Error("host close failed");
            },
          } satisfies StationHostClient;
        },
      });
      await flush();

      expect(() => terminal.kill()).not.toThrow();
      terminal.dispose();
      await flush();

      expect(terminalCorruptionCounters()["terminal_diagnostic:host_close_failed"]).toBe(1);
      expect(closerDisposed).toBe(true);
    } finally {
      resetTerminalDiagnosticsForTest();
    }
  });

  it("kill() is a no-op for an attach-only (agent) terminal", async () => {
    const ctrl = controllableAttachment(ack({ ptyId: "pty-agent" }));
    const tracking: Tracking = { spawns: [], closes: [], spawnPtyId: "unused" };
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-agent",
      size: { cols: 80, rows: 24 },
      clientFactory: trackingClientFactory(ctrl.attachment, tracking),
    });
    await flush();
    terminal.kill();
    await flush();
    expect(tracking.closes).toEqual([]);
  });

  it("publishes only after buffered writes drain and catches a resize that arrives mid-drain", async () => {
    const firstWrite = deferred<void>();
    const ctrl = controllableAttachment(ack(), {
      write: async (data) => {
        if (data === "first") {
          await firstWrite.promise;
        }
      },
    });
    const { terminal } = terminalFor(ctrl.attachment);

    terminal.write("first");
    await flush();
    expect(ctrl.state.writes).toEqual(["first"]);

    terminal.write("second");
    terminal.resize({ cols: 100, rows: 30 });
    firstWrite.resolve(undefined);
    await flush();
    await flush();

    terminal.write("third");
    await flush();

    expect(ctrl.state.writes).toEqual(["first", "second", "third"]);
    expect(ctrl.state.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    ]);
    expect(terminal.ackedSize).toBeUndefined();
    ctrl.push({ type: "resize", ptyId: "pty-1", cols: 100, rows: 30 });
    await flush();
    expect(terminal.ackedSize).toEqual({ cols: 100, rows: 30 });
    terminal.dispose();
  });

  it("rejects resize confirmation from an attachment after its stream drops", async () => {
    const oldResize = deferred<void>();
    const reconnectWait = deferred<void>();
    const first = controllableAttachment(ack(), {
      resize: async (cols, rows) => {
        if (cols === 100 && rows === 30) {
          await oldResize.promise;
        }
      },
    });
    const second = controllableAttachment(ack());
    let clientCreations = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () => {
        const selected = clientCreations === 0 ? first : second;
        clientCreations += 1;
        return clientForAttach(async () => selected.attachment);
      },
      sleep: async () => reconnectWait.promise,
    });

    await flush();
    first.push({ type: "resize", ptyId: "pty-1", cols: 80, rows: 24 });
    await flush();
    expect(terminal.ackedSize).toEqual({ cols: 80, rows: 24 });

    terminal.resize({ cols: 100, rows: 30 });
    await flush();
    first.endStream();
    await flush();
    expect(terminal.ackedSize).toBeUndefined();

    oldResize.resolve(undefined);
    first.push({ type: "resize", ptyId: "pty-1", cols: 100, rows: 30 });
    await flush();
    expect(terminal.ackedSize).toBeUndefined();

    reconnectWait.resolve(undefined);
    await flush();
    terminal.dispose();
  });

  it("retries the failed buffered-write head without duplicating successful writes", async () => {
    const first = controllableAttachment(ack(), {
      write: async (data) => {
        if (data === "second") {
          throw new Error("write transport dropped");
        }
      },
    });
    const second = controllableAttachment(ack());
    let clientCreations = 0;
    const sleeps: number[] = [];
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () => {
        const selected = clientCreations === 0 ? first : second;
        clientCreations += 1;
        return clientForAttach(async () => selected.attachment);
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const exits: number[] = [];
    terminal.onExit((event) => exits.push(event.exitCode));

    terminal.write("first");
    terminal.write("second");
    terminal.write("third");
    await flush();

    expect(first.state.writes).toEqual(["first", "second"]);
    expect(second.state.writes).toEqual(["second", "third"]);
    expect(sleeps).toEqual([250]);
    expect(exits).toEqual([]);
    terminal.dispose();
  });

  it("uses reconnect repaint when activation fails after the initial replay", async () => {
    const first = controllableAttachment(ack({ scrollback: ["history-"] }), {
      resize: async () => {
        throw new Error("resize transport dropped");
      },
    });
    const second = controllableAttachment(ack({ scrollback: ["history-", "gap-"] }));
    let clientCreations = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () => {
        const selected = clientCreations === 0 ? first : second;
        clientCreations += 1;
        return clientForAttach(async () => selected.attachment);
      },
      sleep: async () => {},
    });
    const received: string[] = [];
    terminal.onData((data) => received.push(data));

    await flush();

    expect(received).toEqual([
      "history-",
      RECONNECT_REPAINT,
      "history-",
      "gap-",
    ]);
    terminal.dispose();
  });

  it("replays a semantic reconnect snapshot without a raw-history repaint prefix", async () => {
    const first = controllableAttachment(ack({ scrollback: ["history-"] }));
    const semanticData = "\x1bcsemantic-state";
    const second = controllableAttachment(
      ack({
        replay: {
          kind: "semantic-truncation-recovery",
          initialCols: 80,
          initialRows: 24,
          events: [{ type: "data", data: semanticData }],
        },
      }),
    );
    let clientCreations = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () => {
        const selected = clientCreations === 0 ? first : second;
        clientCreations += 1;
        return clientForAttach(async () => selected.attachment);
      },
      sleep: async () => {},
    });
    const received: string[] = [];
    terminal.onData((data) => received.push(data));

    await flush();
    first.endStream();
    await flush();
    await flush();

    expect(received).toEqual(["history-", semanticData]);
    expect(received).not.toContain(RECONNECT_REPAINT);
    terminal.dispose();
  });

  it("replays Host reset data verbatim before geometry recovery and keeps I/O live", async () => {
    resetTerminalDiagnosticsForTest();
    const resetData = "\x1bc\x1b[?1h\x1b[?2004h\x1b[=5u";
    const ctrl = controllableAttachment(
      ack({
        replay: {
          kind: "live-reset-recovery",
          initialCols: 80,
          initialRows: 24,
          events: [],
          resetData,
        },
      }),
    );
    const { terminal } = terminalFor(ctrl.attachment);
    const replayGate = deferred<void>();
    const replays: StationTerminalReplay[] = [];
    const diagnostics: string[] = [];
    const unavailable: string[] = [];
    const data: string[] = [];
    terminal.onReplay?.(async (replay) => {
      replays.push(replay);
      await replayGate.promise;
    });
    terminal.onDiagnostic((message) => diagnostics.push(message));
    terminal.onUnavailable?.((event) => unavailable.push(event.code));
    terminal.onData((value) => data.push(value));

    try {
      await flush();
      expect(replays).toEqual([
        {
          kind: "live-reset-recovery",
          initialSize: { cols: 80, rows: 24 },
          events: [{ type: "data", data: resetData }],
        },
      ]);
      expect(ctrl.state.resizes).toEqual([]);

      replayGate.resolve(undefined);
      await flush();
      expect(ctrl.state.resizes).toEqual([
        { cols: 80, rows: 24 },
        { cols: 80, rows: 23 },
        { cols: 80, rows: 24 },
      ]);
      expect(diagnostics).toContain(
        "Station reattached to the live terminal without historical output because exact replay was unavailable.",
      );
      expect(terminalCorruptionCounters()["terminal_diagnostic:host_live_reset_recovery"]).toBe(1);
      expect(unavailable).toEqual([]);

      terminal.write("input");
      terminal.resize({ cols: 100, rows: 30 });
      ctrl.push({ type: "data", ptyId: "pty-1", data: "live-after-reset" });
      await flush();
      expect(ctrl.state.writes).toEqual(["input"]);
      expect(ctrl.state.resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
      expect(data).toEqual(["live-after-reset"]);
    } finally {
      replayGate.resolve(undefined);
      terminal.dispose();
      resetTerminalDiagnosticsForTest();
    }
  });

  it("becomes unavailable after exhausting the consecutive transient retry budget", async () => {
    let clientCreations = 0;
    let attachCalls = 0;
    let clientDisposals = 0;
    const sleeps: number[] = [];
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () => {
        clientCreations += 1;
        return clientForAttach(
          async () => {
            attachCalls += 1;
            throw new Error("socket unavailable");
          },
          () => {
            clientDisposals += 1;
          },
        );
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const diagnostics: string[] = [];
    const exits: number[] = [];
    const unavailable: string[] = [];
    terminal.onDiagnostic((message) => diagnostics.push(message));
    terminal.onExit((event) => exits.push(event.exitCode));
    terminal.onUnavailable?.((event) => unavailable.push(event.code));

    await flush();

    expect(attachCalls).toBe(6);
    expect(clientCreations).toBe(6);
    expect(clientDisposals).toBe(5);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000]);
    expect(diagnostics.filter((message) => message === "Station host reconnect failed.")).toHaveLength(
      1,
    );
    expect(exits).toEqual([]);
    expect(unavailable).toEqual(["HOST_UNREACHABLE"]);
  });

  it("reconnects after a transient attach failure instead of killing the pane", async () => {
    const ctrl = controllableAttachment(ack({ scrollback: ["scroll-"] }));
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            // First attempt fails with a non-gone (transport) error: a plain
            // Error normalizes to HOST_REQUEST_FAILED, which is transient.
            if (attachCalls === 1) {
              throw new Error("socket hiccup");
            }
            return ctrl.attachment;
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          stopIfIdle: async () => ({ stopping: true }),
          spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
          write: async () => undefined,
          resize: async () => undefined,
          list: async () => [],
          focus: async () => undefined,
          close: async () => ({ closed: true }),
        }) satisfies StationHostClient,
    });
    const received: string[] = [];
    const exits: number[] = [];
    terminal.onData((data) => received.push(data));
    terminal.onExit((event) => exits.push(event.exitCode));

    // Wait past the first reconnect backoff (~250ms).
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(attachCalls).toBeGreaterThanOrEqual(2);
    expect(exits).toEqual([]); // the pane was NOT killed by the blip
    expect(received).toEqual(["scroll-"]); // scrollback replayed once, on reconnect

    ctrl.push({ type: "data", ptyId: "pty-1", data: "live" });
    await flush();
    expect(received).toEqual(["scroll-", "live"]); // streaming resumed
  });

  it("repaints the gap output on reconnect after a dropped stream (does not lose it)", async () => {
    const first = controllableAttachment(ack({ scrollback: ["history-"] }));
    // The host ring captured output produced while we were detached, so the
    // reconnect ack carries more scrollback than the first attach did.
    const second = controllableAttachment(ack({ scrollback: ["history-", "gap-"] }));
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            return attachCalls === 1 ? first.attachment : second.attachment;
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          stopIfIdle: async () => ({ stopping: true }),
          spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
          write: async () => undefined,
          resize: async () => undefined,
          list: async () => [],
          focus: async () => undefined,
          close: async () => ({ closed: true }),
        }) satisfies StationHostClient,
    });
    const received: string[] = [];
    const exits: number[] = [];
    terminal.onData((data) => received.push(data));
    terminal.onExit((event) => exits.push(event.exitCode));

    await flush(); // first attach replays history once
    expect(received).toEqual(["history-"]);

    first.endStream(); // socket drops with no exit frame
    await new Promise((resolve) => setTimeout(resolve, 400)); // past reconnect backoff

    expect(exits).toEqual([]); // pane stayed alive
    // The repaint preamble MUST precede the replayed snapshot, so the history the
    // VT already shows is cleared before it is re-emitted (no duplication).
    expect(received).toEqual(["history-", RECONNECT_REPAINT, "history-", "gap-"]);
  });

  it("nudges the child on an empty-ring reconnect so the pane is not left blank", async () => {
    // Same-size reconnect with nothing in the ring: without a nudge the child
    // never gets a SIGWINCH and the pane stays whatever it last showed.
    const first = controllableAttachment(ack({ scrollback: [] }));
    const second = controllableAttachment(ack({ scrollback: [] }));
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            return attachCalls === 1 ? first.attachment : second.attachment;
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          stopIfIdle: async () => ({ stopping: true }),
          spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
          write: async () => undefined,
          resize: async () => undefined,
          list: async () => [],
          focus: async () => undefined,
          close: async () => ({ closed: true }),
        }) satisfies StationHostClient,
    });
    const exits: number[] = [];
    terminal.onExit((event) => exits.push(event.exitCode));

    await flush();
    // First attach, empty ring: no flap (a fresh spawn need not be nudged).
    expect(first.state.resizes).toEqual([{ cols: 80, rows: 24 }]);

    first.endStream();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(exits).toEqual([]);
    // Reconnect flapped the rows (24 -> 23 -> 24) to force a repaint.
    expect(second.state.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 23 },
      { cols: 80, rows: 24 },
    ]);
  });

  it("does not reconnect (or kill the pane) when a replay listener throws", async () => {
    const ctrl = controllableAttachment(ack({ scrollback: ["hist-"] }));
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            return ctrl.attachment;
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          stopIfIdle: async () => ({ stopping: true }),
          spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
          write: async () => undefined,
          resize: async () => undefined,
          list: async () => [],
          focus: async () => undefined,
          close: async () => ({ closed: true }),
        }) satisfies StationHostClient,
    });
    const diagnostics: string[] = [];
    const exits: number[] = [];
    terminal.onDiagnostic((message) => diagnostics.push(message));
    terminal.onExit((event) => exits.push(event.exitCode));
    // A render/VT error while parsing the replay must be isolated: previously it
    // rejected the attach, was treated as a transport fault, and reconnected —
    // re-feeding the snapshot and eventually killing a healthy PTY.
    terminal.onReplay?.(() => {
      throw new Error("vt parse blew up");
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(attachCalls).toBe(1); // no reconnect from the listener throw
    expect(exits).toEqual([]); // pane stayed alive
    expect(diagnostics.length).toBeGreaterThan(0); // the failure was surfaced, not swallowed
  });

  it("keeps reconnecting a long-lived pane across many drops (budget is consecutive, not lifetime)", async () => {
    // A pane that has streamed for a while then drops should earn a fresh retry
    // budget each time — otherwise the lifetime cap eventually kills a healthy
    // pane (the exact failure finding 2.2 set out to prevent).
    let clock = 0;
    let attachCalls = 0;
    let current = controllableAttachment(ack());
    const sleeps: number[] = [];
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      now: () => clock,
      clientFactory: () =>
        clientForAttach(async () => {
          attachCalls += 1;
          current = controllableAttachment(ack());
          return current.attachment;
        }),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const exits: number[] = [];
    terminal.onExit((event) => exits.push(event.exitCode));
    await flush(); // first attach

    // Drop 8 times — well past MAX_ATTACH_ATTEMPTS. Each connection "outlives" the
    // backoff window (clock advances 5s), so every drop is a healthy reconnect.
    for (let i = 0; i < 8; i += 1) {
      clock += 5_000;
      current.endStream();
      await flush();
    }
    expect(exits).toEqual([]); // never killed despite > MAX_ATTACH_ATTEMPTS drops
    expect(attachCalls).toBe(9); // it kept redialing each time
    // The fresh-budget reset computes its preserved 125 ms delay from attempt -1.
    expect(sleeps).toEqual(Array.from({ length: 8 }, () => 125));
    terminal.dispose();
  });

  it("retries HOST_SNAPSHOT_PENDING before declaring attachment unavailable", async () => {
    let attachCalls = 0;
    const opened = controllableAttachment(ack());
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-pending",
      size: { cols: 80, rows: 24 },
      sleep: async () => undefined,
      clientFactory: () =>
        clientForAttach(async () => {
          attachCalls += 1;
          if (attachCalls === 1) {
            throw new StationHostProviderError(
              "HOST_SNAPSHOT_PENDING",
              "terminal parser sequence is unfinished",
            );
          }
          return opened.attachment;
        }),
    });
    const unavailable: string[] = [];
    terminal.onUnavailable?.((event) => unavailable.push(event.code));

    await flush();
    await flush();
    expect(attachCalls).toBe(2);
    expect(unavailable).toEqual([]);
    terminal.dispose();
  });

  it("reports HOST_SNAPSHOT_PENDING when parser-boundary retries are exhausted", async () => {
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-pending",
      size: { cols: 80, rows: 24 },
      sleep: async () => undefined,
      clientFactory: () =>
        clientForAttach(async () => {
          attachCalls += 1;
          throw new StationHostProviderError(
            "HOST_SNAPSHOT_PENDING",
            "terminal parser sequence is unfinished",
          );
        }),
    });
    const unavailable: string[] = [];
    terminal.onUnavailable?.((event) => unavailable.push(event.code));

    await flush();
    expect(attachCalls).toBe(6);
    expect(unavailable).toEqual(["HOST_SNAPSHOT_PENDING"]);
  });

  for (const code of [
    "HOST_ATTACH_GONE",
    "HOST_SNAPSHOT_FAILED",
    "HOST_VERSION_INCOMPATIBLE",
    "HOST_CLIENT_IDENTITY_MISMATCH",
    "HOST_UPGRADE_BLOCKED",
    "HOST_BAD_REQUEST",
  ] as const) {
    it(`classifies ${code} without retrying or fabricating process state`, async () => {
      let attachCalls = 0;
      const terminal = createHostAttachedTerminal({
        hostSocketPath: "/tmp/x.sock",
        ptyId: "pty-gone",
        size: { cols: 80, rows: 24 },
        clientFactory: () =>
          ({
            attach: async () => {
              attachCalls += 1;
              throw new StationHostProviderError(code, "host attachment is unavailable");
            },
            dispose: () => {},
            health: async () => ({ ok: true, protocolVersion: 1 }),
            stopIfIdle: async () => ({ stopping: true }),
            spawn: async () => ({ ptyId: "pty-gone", pid: 1 }),
            write: async () => undefined,
            resize: async () => undefined,
            list: async () => [],
            focus: async () => undefined,
            close: async () => ({ closed: true }),
          }) satisfies StationHostClient,
      });
      const exits: number[] = [];
      const unavailable: string[] = [];
      terminal.onExit((event) => exits.push(event.exitCode));
      terminal.onUnavailable?.((event) => unavailable.push(event.code));
      await flush();
      expect(exits).toEqual(code === "HOST_ATTACH_GONE" ? [1] : []);
      expect(unavailable).toEqual(code === "HOST_ATTACH_GONE" ? [] : [code]);
      expect(attachCalls).toBe(1);
    });
  }

  it("kill() before the spawn resolves still closes the PTY once it exists", async () => {
    const ctrl = controllableAttachment(ack({ ptyId: "pty-late" }));
    const tracking: Tracking = { spawns: [], closes: [], spawnPtyId: "pty-late" };
    // Defer the spawn so kill() lands while it is in flight.
    let releaseSpawn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      size: { cols: 80, rows: 24 },
      spawn: auxSpawn,
      clientFactory: () =>
        ({
          attach: async () => ctrl.attachment,
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          stopIfIdle: async () => ({ stopping: true }),
          spawn: async (params: unknown) => {
            await gate;
            tracking.spawns.push(params);
            return { ptyId: tracking.spawnPtyId, pid: 1 };
          },
          write: async () => undefined,
          resize: async () => undefined,
          list: async () => [],
          focus: async () => undefined,
          close: async (ptyId: string) => {
            tracking.closes.push(ptyId);
            return { closed: true };
          },
        }) satisfies StationHostClient,
    });
    terminal.kill(); // requested before the PTY exists
    releaseSpawn();
    await flush();
    await flush();
    expect(tracking.closes).toEqual(["pty-late"]);
  });
});
