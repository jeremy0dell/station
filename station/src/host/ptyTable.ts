import {
  type HostAttachAck,
  type HostAttachmentSource,
  type HostExitFrame,
  type HostFrame,
  type HostListEntry,
  type HostPtyIdentity,
  type HostSpawnParams,
  type HostSpawnResult,
  StationHostProviderError,
} from "@station/host";
import { createLocalPtyTerminal } from "../terminal/pty/localPtyTerminal.js";
import type {
  StationTerminalDisposable,
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";
import { ScrollbackRing } from "./scrollbackRing.js";

const MIN_COLS = 2;
const MIN_ROWS = 1;
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

export type PtyTableOptions = {
  /** Test seam: inject a fake terminal so unit tests need no real node-pty. */
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  maxScrollbackBytes?: number;
  /** Lifecycle observability — redaction-safe ids/counts only, never PTY data/env. */
  onEvent?: (event: string, attributes: Record<string, unknown>) => void;
};

/** Snapshot used to build a `host.attach` ack (and assert capture in tests). */
export type PtySnapshot = {
  pid: number;
  cols: number;
  rows: number;
  exited: boolean;
  scrollback: string[];
  truncated: boolean;
};

export type PtyTable = {
  spawn(params: HostSpawnParams): HostSpawnResult;
  write(ptyId: string, data: string): void;
  resize(ptyId: string, cols: number, rows: number): void;
  list(): HostListEntry[];
  snapshot(ptyId: string): PtySnapshot;
  /**
   * Open an attachment: capture the scrollback snapshot and register the live
   * sink ATOMICALLY (same tick), so `snapshot ++ live frames` has no gap or
   * overlap. The frame stream ends on PTY exit (after delivering the exit frame),
   * on `frames.return()` (detach), or when the host disposes the PTY.
   */
  attach(ptyId: string): HostAttachmentSource;
  /** Guarded kill: dispose the PTY, broadcast exit to attached clients, drop it. */
  close(ptyId: string): boolean;
  /** Best-effort focus: broadcast a focus frame to attached clients. */
  focus(ptyId: string): boolean;
  has(ptyId: string): boolean;
  disposeAll(): void;
};

type PtyEntry = {
  ptyId: string;
  identity: HostPtyIdentity;
  terminal: StationTerminalProcess;
  ring: ScrollbackRing;
  cols: number;
  rows: number;
  exited: boolean;
  lastExit?: HostExitFrame;
  sinks: Set<(frame: HostFrame) => void>;
  subscriptions: StationTerminalDisposable[];
};

export function createPtyTable(options: PtyTableOptions = {}): PtyTable {
  const createTerminal = options.createTerminal ?? createLocalPtyTerminal;
  const maxScrollbackBytes = options.maxScrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
  const emit = options.onEvent ?? (() => undefined);
  const entries = new Map<string, PtyEntry>();
  let sequence = 0;

  function identityOf(params: HostSpawnParams): HostPtyIdentity {
    return {
      // `kind` distinguishes UI-owned aux shells from agents; it must round-trip
      // through host.list so the observer can exclude aux and the UI can warm-
      // reattach them. Defaulted to "agent" by the schema for pre-kind spawns.
      kind: params.kind,
      terminalTargetId: params.terminalTargetId,
      worktreeId: params.worktreeId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      worktreePath: params.worktreePath,
      harnessProvider: params.harnessProvider,
    };
  }

  function broadcast(entry: PtyEntry, frame: HostFrame): void {
    for (const sink of [...entry.sinks]) {
      sink(frame);
    }
  }

  // Broadcast a terminal exit, release the terminal's resources, and DROP the
  // entry. Used by natural exit, guarded close, and shutdown — so the host never
  // accumulates dead entries (each retaining its scrollback ring) and a re-spawn
  // for a worktree never finds a stale exited entry under the same target id.
  function reap(entry: PtyEntry, exitFrame: HostExitFrame, reason: string): void {
    entry.exited = true;
    entry.lastExit = exitFrame;
    broadcast(entry, exitFrame);
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.terminal.dispose();
    entries.delete(entry.ptyId);
    emit("agent.exit", { ptyId: entry.ptyId, exitCode: exitFrame.exitCode, reason });
  }

  function require(ptyId: string): PtyEntry {
    const entry = entries.get(ptyId);
    if (entry === undefined) {
      throw new StationHostProviderError("HOST_PTY_NOT_FOUND", `No host PTY "${ptyId}".`);
    }
    return entry;
  }

  return {
    spawn(params) {
      // Idempotent per worktree: a live PTY for the same target is reused so a
      // racing second prepare/launch never forks two agents for one worktree.
      for (const existing of entries.values()) {
        if (!existing.exited && existing.identity.terminalTargetId === params.terminalTargetId) {
          return { ptyId: existing.ptyId, pid: existing.terminal.pid };
        }
      }

      const cols = Math.max(MIN_COLS, params.cols);
      const rows = Math.max(MIN_ROWS, params.rows);
      const terminal = createTerminal({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        ...(params.env === undefined ? {} : { env: params.env }),
        size: { cols, rows },
      });

      sequence += 1;
      const entry: PtyEntry = {
        ptyId: `pty-${sequence}`,
        identity: identityOf(params),
        terminal,
        ring: new ScrollbackRing(maxScrollbackBytes),
        cols,
        rows,
        exited: false,
        sinks: new Set(),
        subscriptions: [],
      };

      entry.subscriptions.push(
        terminal.onData((data) => {
          entry.ring.push(data);
          broadcast(entry, { type: "data", ptyId: entry.ptyId, data });
        }),
      );
      entry.subscriptions.push(
        terminal.onExit((event) => {
          reap(
            entry,
            {
              type: "exit",
              ptyId: entry.ptyId,
              exitCode: event.exitCode,
              ...(event.signal === undefined ? {} : { signal: event.signal }),
            },
            "exit",
          );
        }),
      );

      entries.set(entry.ptyId, entry);
      emit("agent.spawn", {
        ptyId: entry.ptyId,
        worktreeId: params.worktreeId,
        sessionId: params.sessionId,
        terminalTargetId: params.terminalTargetId,
      });
      // pid stabilizes to PTY's child once bridge reports ready; host.list is authoritative.
      return { ptyId: entry.ptyId, pid: terminal.pid };
    },

    write(ptyId, data) {
      require(ptyId).terminal.write(data);
    },

    resize(ptyId, cols, rows) {
      const entry = require(ptyId);
      entry.cols = Math.max(MIN_COLS, cols);
      entry.rows = Math.max(MIN_ROWS, rows);
      entry.terminal.resize({ cols: entry.cols, rows: entry.rows });
    },

    list() {
      const list: HostListEntry[] = [];
      for (const entry of entries.values()) {
        list.push({
          ...entry.identity,
          ptyId: entry.ptyId,
          pid: entry.terminal.pid,
          alive: !entry.exited,
          cols: entry.cols,
          rows: entry.rows,
        });
      }
      return list;
    },

    snapshot(ptyId) {
      const entry = require(ptyId);
      const { scrollback, truncated } = entry.ring.snapshot();
      return {
        pid: entry.terminal.pid,
        cols: entry.cols,
        rows: entry.rows,
        exited: entry.exited,
        scrollback,
        truncated,
      };
    },

    attach(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        // Attach-specific code: the agent the client expected is gone. A
        // first-class diagnosable failure, never a silent fall-through to respawn.
        throw new StationHostProviderError(
          "HOST_ATTACH_GONE",
          `No host PTY "${ptyId}" to attach to.`,
        );
      }
      const snap = entry.ring.snapshot();
      const ack: HostAttachAck = {
        subscribed: true,
        ptyId: entry.ptyId,
        pid: entry.terminal.pid,
        cols: entry.cols,
        rows: entry.rows,
        exited: entry.exited,
        scrollback: snap.scrollback,
        truncated: snap.truncated,
      };
      let sink: ((frame: HostFrame) => void) | undefined;
      const stream = createFrameStream(() => {
        if (sink !== undefined) {
          entry.sinks.delete(sink);
        }
      });
      if (entry.exited) {
        // PTY already gone: ack carries exited+scrollback; no live frames follow.
        stream.end();
      } else {
        sink = (frame) => {
          stream.push(frame);
          if (frame.type === "exit") {
            stream.end();
          }
        };
        entry.sinks.add(sink);
      }
      return { ack, frames: stream.frames };
    },

    close(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        return false;
      }
      reap(entry, { type: "exit", ptyId: entry.ptyId, exitCode: 0 }, "close");
      return true;
    },

    focus(ptyId) {
      const entry = entries.get(ptyId);
      if (entry === undefined) {
        return false;
      }
      // Best-effort: ask attached clients to surface this pane. With no client
      // attached it is a no-op; the observer's focusTarget does not depend on it.
      broadcast(entry, { type: "focus", ptyId: entry.ptyId });
      emit("agent.focus", { ptyId: entry.ptyId });
      return true;
    },

    has(ptyId) {
      return entries.has(ptyId);
    },

    disposeAll() {
      // Reap each (broadcast exit → attached streams end → dispose → drop) so a
      // shutdown never leaves a client's frame iterator hanging.
      for (const entry of [...entries.values()]) {
        reap(entry, { type: "exit", ptyId: entry.ptyId, exitCode: 0 }, "host-stop");
      }
    },
  };
}

type FrameStream = {
  frames: AsyncIterable<HostFrame>;
  push(frame: HostFrame): void;
  end(): void;
};

/** A pull-based frame stream fed by `push`/`end`; `frames.return()` runs onReturn. */
function createFrameStream(onReturn: () => void): FrameStream {
  const queue: HostFrame[] = [];
  const waiters: Array<(result: IteratorResult<HostFrame>) => void> = [];
  let ended = false;

  const drain = () => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        break;
      }
      const next = queue.shift();
      waiter(next === undefined ? { done: true, value: undefined } : { done: false, value: next });
    }
  };

  return {
    push: (frame) => {
      queue.push(frame);
      drain();
    },
    end: () => {
      ended = true;
      drain();
    },
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<HostFrame>>((resolve) => {
            const next = queue.shift();
            if (next !== undefined) {
              resolve({ done: false, value: next });
              return;
            }
            if (ended) {
              resolve({ done: true, value: undefined });
              return;
            }
            waiters.push(resolve);
          }),
        return: () => {
          ended = true;
          onReturn();
          drain();
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}
