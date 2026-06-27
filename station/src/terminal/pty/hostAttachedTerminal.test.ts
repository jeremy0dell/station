import {
  type HostAttachAck,
  type HostAttachment,
  type HostFrame,
  type StationHostClient,
  StationHostProviderError,
} from "@station/host";
import { describe, expect, it } from "bun:test";
import { createHostAttachedTerminal, RECONNECT_REPAINT } from "./hostAttachedTerminal.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function controllableAttachment(ack: HostAttachAck) {
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
    },
    resize: async (cols, rows) => {
      resizes.push({ cols, rows });
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

function ack(overrides: Partial<HostAttachAck> = {}): HostAttachAck {
  return {
    subscribed: true,
    ptyId: "pty-1",
    pid: 4242,
    cols: 80,
    rows: 24,
    exited: false,
    scrollback: [],
    truncated: false,
    ...overrides,
  };
}

function terminalFor(attachment: HostAttachment) {
  let clientDisposed = false;
  const terminal = createHostAttachedTerminal({
    hostSocketPath: "/tmp/unused.sock",
    ptyId: "pty-1",
    size: { cols: 80, rows: 24 },
    clientFactory: () =>
      ({
        attach: async () => attachment,
        dispose: () => {
          clientDisposed = true;
        },
        health: async () => ({ ok: true, protocolVersion: 1 }),
        spawn: async () => ({ ptyId: "pty-1", pid: 4242 }),
        write: async () => undefined,
        resize: async () => undefined,
        list: async () => [],
        focus: async () => undefined,
        close: async () => ({ closed: true }),
      }) satisfies StationHostClient,
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

  it("buffers writes/resizes before attach resolves, then flushes them", async () => {
    const ctrl = controllableAttachment(ack());
    const { terminal } = terminalFor(ctrl.attachment);
    terminal.write("pre");
    terminal.resize({ cols: 100, rows: 30 });
    await flush();
    expect(ctrl.state.writes).toEqual(["pre"]);
    expect(ctrl.state.resizes).toEqual([{ cols: 100, rows: 30 }]);
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
});

type Tracking = { spawns: unknown[]; closes: string[]; spawnPtyId: string };

function trackingClientFactory(attachment: HostAttachment, tracking: Tracking) {
  return () =>
    ({
      attach: async () => attachment,
      dispose: () => {},
      health: async () => ({ ok: true, protocolVersion: 1 }),
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

  it("keeps reconnecting a long-lived pane across many drops (budget is consecutive, not lifetime)", async () => {
    // A pane that has streamed for a while then drops should earn a fresh retry
    // budget each time — otherwise the lifetime cap eventually kills a healthy
    // pane (the exact failure finding 2.2 set out to prevent).
    let clock = 0;
    let attachCalls = 0;
    let current = controllableAttachment(ack());
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-1",
      size: { cols: 80, rows: 24 },
      now: () => clock,
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            current = controllableAttachment(ack());
            return current.attachment;
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
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
    await flush(); // first attach

    // Drop 8 times — well past MAX_ATTACH_ATTEMPTS. Each connection "outlives" the
    // backoff window (clock advances 5s), so every drop is a healthy reconnect.
    for (let i = 0; i < 8; i += 1) {
      clock += 5_000;
      current.endStream();
      await new Promise((resolve) => setTimeout(resolve, 300)); // past healthy backoff
    }
    expect(exits).toEqual([]); // never killed despite > MAX_ATTACH_ATTEMPTS drops
    expect(attachCalls).toBeGreaterThan(8); // it kept redialing each time
  });

  it("ends the pane without retrying when the host reports the PTY is gone", async () => {
    let attachCalls = 0;
    const terminal = createHostAttachedTerminal({
      hostSocketPath: "/tmp/x.sock",
      ptyId: "pty-gone",
      size: { cols: 80, rows: 24 },
      clientFactory: () =>
        ({
          attach: async () => {
            attachCalls += 1;
            throw new StationHostProviderError("HOST_ATTACH_GONE", "pty is gone");
          },
          dispose: () => {},
          health: async () => ({ ok: true, protocolVersion: 1 }),
          spawn: async () => ({ ptyId: "pty-gone", pid: 1 }),
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
    expect(exits).toEqual([1]);
    expect(attachCalls).toBe(1); // a gone PTY is terminal, not retried
  });

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
