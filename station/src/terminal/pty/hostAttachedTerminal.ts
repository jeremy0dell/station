import {
  createStationHostClient,
  isStationHostCompatibilityError,
  STATION_HOST_PROVIDER_ID,
  type HostAttachment,
  type HostSpawnParamsInput,
  type StationHostClient,
} from "@station/host";
import { type SafeErrorFallback, toSafeError } from "@station/observability";
import { stationBuildInfo } from "@station/runtime";
import { reportTerminalCorruption } from "../diagnostics.js";
import { ControlByte } from "../protocol/controlBytes.js";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalReplay,
  StationTerminalSize,
} from "../types.js";

// Host data-plane faults arrive as StationHostProviderError (a SafeError);
// `toSafeError` returns it as-is and only uses this fallback for an unexpected
// non-SafeError throw (e.g. a raw socket error), keeping the tag/provider
// consistent with the host's own errors.
const HOST_DATA_PLANE_FALLBACK: SafeErrorFallback = {
  tag: "TerminalProviderError",
  code: "HOST_REQUEST_FAILED",
  message: "The station host request failed.",
  provider: STATION_HOST_PROVIDER_ID,
};

// A dropped attach connection (host restart, socket hiccup, hot-reload) is
// transient: reconnect a bounded number of times with backoff before giving up,
// so a blip doesn't permanently kill a pane whose PTY is still alive. Permanent
// host faults end the pane because retrying cannot recover this attachment.
const MAX_ATTACH_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const PTY_GONE_CODES = new Set(["HOST_ATTACH_GONE", "HOST_PTY_NOT_FOUND"]);
// Reconnect repaint: cursor home, clear screen, clear scrollback. Lets us replay
// the fresh ring snapshot on reconnect (which holds output produced while we were
// detached) without stacking it on top of the history the VT already shows.
// Exported so the reconnect test can pin that it precedes the replayed snapshot.
export const RECONNECT_REPAINT = `${ControlByte.Csi}H${ControlByte.Csi}2J${ControlByte.Csi}3J`;
const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unreachableAttachmentState = (_value: never): never => {
  throw new Error("Unexpected Station Host attachment state.");
};

type AttachmentFailure =
  | { kind: "fatal"; message: string }
  | { kind: "transient"; message: string };

type AttachmentStreamOutcome =
  | { kind: "disconnected" }
  | { kind: "exited"; exit: StationTerminalExit };

type AttachAttemptOutcome =
  | { kind: "complete" }
  | {
      kind: "reconnect";
      replayed: boolean;
      connectedAt: number | undefined;
    };

type AttachmentPreparationState = { replayed: boolean };

type ReconnectPreparationOutcome =
  | { kind: "stop" }
  | { kind: "exhausted" }
  | { kind: "retry"; attempt: number };

type AttachLoopStep =
  | { kind: "complete" }
  | { kind: "exhausted" }
  | { kind: "retry"; attempt: number; replayed: boolean };

export type HostAttachedTerminalOptions = {
  hostSocketPath: string;
  /** Attach to this existing host PTY. Required unless `spawn` is supplied. */
  ptyId?: string;
  /**
   * Spawned aux PTYs are Station-owned: `kill()` closes them on the host. Attach
   * only terminals just detach because the observer owns agent lifecycles.
   */
  spawn?: HostSpawnParamsInput;
  /**
   * Mark an ATTACH (no `spawn`) as Station-owned so `kill()` closes it — used when
   * REATTACHING to an aux PTY on restore (the spawn happened a session ago).
   * Spawning always implies ownership; an agent attach leaves this false.
   */
  owned?: boolean;
  size: StationTerminalSize;
  /** Test seam; production dials the host unix socket. */
  clientFactory?: (socketPath: string) => StationHostClient;
  /** Test seam for the reconnect-budget clock; production uses wall time. */
  now?: () => number;
  /** Test seam for reconnect waits; production uses wall-clock timers. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Host-attached `StationTerminalProcess`: attach, replay scrollback, then stream
 * live frames. `dispose()` only detaches, so the host keeps the PTY alive for the
 * next reattach and PtyRegistry needs no persistent-agent special case.
 */
export function createHostAttachedTerminal(
  options: HostAttachedTerminalOptions,
): StationTerminalProcess {
  const makeClient =
    options.clientFactory ??
    ((path) =>
      createStationHostClient({
        socketPath: path,
        expectedBuildVersion: stationBuildInfo().version,
      }));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? delay;
  // Reassigned on reconnect: the host client does not auto-reconnect, so a dropped
  // connection is replaced with a fresh one.
  let client = makeClient(options.hostSocketPath);
  // Station OWNS this aux PTY — it spawned it, or is reattaching to one it spawned
  // earlier — so kill() may close it on the host. An agent attach leaves this
  // false: the observer owns an agent's lifecycle.
  const ownsPty = options.spawn !== undefined || options.owned === true;
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: StationTerminalExit) => void>();
  const diagnosticListeners = new Set<(message: string) => void>();
  const replayListeners = new Set<(replay: StationTerminalReplay) => void | Promise<void>>();
  const pendingData: string[] = [];
  const pendingWrites: string[] = [];
  let attachment: HostAttachment | undefined;
  let size = options.size;
  // The size the host PTY last CONFIRMED applying (not the size we asked for);
  // a persistent gap between this and `size` is geometry divergence.
  let ackedSize: StationTerminalSize | undefined;
  // Monotonic so only the newest resize's ack stamps `ackedSize` — out-of-order
  // resolutions from concurrent resizes cannot pin it to a stale geometry.
  let resizeSeq = 0;
  let pid = 0;
  let exited = false;
  let disposed = false;
  let resolvedPtyId = options.ptyId;
  let closeRequested = false;

  // Close an owned (aux) PTY on the host. Uses a SEPARATE short-lived client so
  // the request can't be cut off by dispose() tearing down the attach connection
  // in the same tick (a pane close fires kill() then, via reconcile, dispose()).
  const closeOwnedPty = (): void => {
    const id = resolvedPtyId;
    if (id === undefined) {
      return;
    }
    const closer = makeClient(options.hostSocketPath);
    closer
      .close(id)
      .catch((error) => {
        const safeError = toSafeError(error, HOST_DATA_PLANE_FALLBACK);
        // Pane disposal clears listeners before this settles, so process-level telemetry
        // retains the close failure without widening the synchronous terminal contract.
        reportTerminalCorruption({
          kind: "terminal_diagnostic",
          key: "host_close_failed",
          detail: {
            code: safeError.code,
            message: safeError.message,
            ptyId: id,
          },
        });
      })
      .finally(() => closer.dispose());
  };

  const emitData = (data: string): void => {
    if (disposed) {
      return;
    }
    if (dataListeners.size === 0) {
      pendingData.push(data);
      return;
    }
    for (const listener of dataListeners) {
      listener(data);
    }
  };
  const emitExit = (event: StationTerminalExit): void => {
    exited = true;
    for (const listener of exitListeners) {
      listener(event);
    }
  };
  const emitDiagnostic = (message: string): void => {
    if (disposed) {
      return;
    }
    for (const listener of diagnosticListeners) {
      listener(message);
    }
  };
  // Snapshot bytes were painted for the host PTY's recorded size, not this
  // pane's. A wired replay listener gets them with that size and is awaited so
  // live frames never interleave with the replay parse; with no listener the
  // chunks fall back to the plain data path (recorded size unknown to it).
  const emitReplay = async (
    chunks: readonly string[],
    recordedSize: StationTerminalSize,
  ): Promise<void> => {
    if (disposed) {
      return;
    }
    if (replayListeners.size === 0) {
      for (const chunk of chunks) {
        emitData(chunk);
      }
      return;
    }
    // A listener that throws (a render/VT error while parsing the replay) must
    // NOT reject here: the attach loop would treat it as a transport fault and
    // reconnect, re-feeding the whole snapshot and eventually killing a healthy
    // PTY. The async wrapper catches a synchronous throw as well as a rejection.
    await Promise.all(
      [...replayListeners].map(async (listener) => {
        try {
          return await listener({ size: recordedSize, chunks });
        } catch (error) {
          emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
          return;
        }
      }),
    );
  };

  // Send a resize to the attached host PTY and stamp `ackedSize` to the size
  // that was actually sent — but only if this remains the newest resize, so a
  // slow ack cannot revert `ackedSize` to a superseded geometry. No-ops while
  // detached; the size is (re)sent by the attach loop once `attachment` is set.
  const applyHostResize = (target: StationTerminalSize): void => {
    const opened = attachment;
    if (opened === undefined) {
      return;
    }
    const seq = (resizeSeq += 1);
    opened
      .resize(target.cols, target.rows)
      .then(() => {
        if (seq === resizeSeq) {
          ackedSize = target;
        }
      })
      .catch((error) => {
        emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
      });
  };

  // First attachment replays the initial snapshot; reconnects clear and repaint
  // only when the fresh ring contains history that can replace the shown frame.
  const replayAttachmentSnapshot = async (
    opened: HostAttachment,
    isReconnect: boolean,
  ): Promise<void> => {
    const recordedSize = { cols: opened.ack.cols, rows: opened.ack.rows };
    if (!isReconnect) {
      await emitReplay(opened.ack.scrollback, recordedSize);
      return;
    }
    if (opened.ack.scrollback.length > 0) {
      await emitReplay([RECONNECT_REPAINT, ...opened.ack.scrollback], recordedSize);
    }
    // An empty reconnect ring must not clear the pane with nothing to replace it;
    // the geometry nudge below asks the child to repaint instead.
  };

  const synchronizeAttachmentGeometry = async (
    opened: HostAttachment,
    isReconnect: boolean,
  ): Promise<StationTerminalSize> => {
    // Snapshot each target before awaiting so the returned acknowledgement always
    // describes geometry the host actually applied, not a newer pane assertion.
    const attachTarget = { cols: size.cols, rows: size.rows };
    await opened.resize(attachTarget.cols, attachTarget.rows);
    if (disposed) {
      return attachTarget;
    }
    // A same-size TIOCSWINSZ emits no SIGWINCH, so stale same-size frames need a
    // temporary row change whenever replay or reconnect requires a child repaint.
    const sizeUnchanged = size.cols === attachTarget.cols && size.rows === attachTarget.rows;
    if (
      sizeUnchanged &&
      (isReconnect || opened.ack.scrollback.length > 0) &&
      opened.ack.cols === attachTarget.cols &&
      opened.ack.rows === attachTarget.rows
    ) {
      const nudgeTarget = {
        cols: attachTarget.cols,
        rows: attachTarget.rows > 1 ? attachTarget.rows - 1 : attachTarget.rows + 1,
      };
      await opened.resize(nudgeTarget.cols, nudgeTarget.rows);
      if (disposed) {
        return nudgeTarget;
      }
      const restoreTarget = { cols: size.cols, rows: size.rows };
      await opened.resize(restoreTarget.cols, restoreTarget.rows);
      return restoreTarget;
    }
    // Publication compares this exact sent size with the latest pane assertion,
    // catching changes during geometry synchronization or the buffered-write drain.
    return attachTarget;
  };

  const drainPendingWrites = async (opened: HostAttachment): Promise<void> => {
    // Shift only after a successful write so reconnect retries the failed head
    // without duplicating writes that the prior attachment already accepted.
    while (!disposed && pendingWrites.length > 0) {
      const data = pendingWrites[0];
      if (data === undefined) {
        break;
      }
      await opened.write(data);
      pendingWrites.shift();
    }
  };

  const publishPreparedAttachment = (
    opened: HostAttachment,
    attachSentSize: StationTerminalSize,
  ): void => {
    // Publishing after the drain keeps later writes behind every buffered write.
    attachment = opened;
    if (size.cols !== attachSentSize.cols || size.rows !== attachSentSize.rows) {
      // A resize arrived during attach; resize() no-op'd then, so send it now.
      applyHostResize(size);
      return;
    }
    // Host is at the size we just drove it to; record it as confirmed.
    ackedSize = attachSentSize;
  };

  const consumeAttachmentFrames = async (
    opened: HostAttachment,
  ): Promise<AttachmentStreamOutcome> => {
    for await (const frame of opened.frames) {
      switch (frame.type) {
        case "data":
          emitData(frame.data);
          break;
        case "exit":
          return {
            kind: "exited",
            exit: {
              exitCode: frame.exitCode ?? 0,
              ...(frame.signal === undefined || frame.signal === null
                ? {}
                : { signal: frame.signal }),
            },
          };
        case "focus":
          // Focus is best-effort host metadata with no terminal-output meaning.
          break;
        default:
          return unreachableAttachmentState(frame);
      }
    }
    // No exit frame means the transport vanished while the host PTY may live.
    return { kind: "disconnected" };
  };

  const classifyAttachmentFailure = (error: unknown): AttachmentFailure => {
    const compatibilityFailure = isStationHostCompatibilityError(error);
    const safe = toSafeError(error, HOST_DATA_PLANE_FALLBACK);
    if (PTY_GONE_CODES.has(safe.code) || compatibilityFailure) {
      return { kind: "fatal", message: safe.message };
    }
    return { kind: "transient", message: safe.message };
  };

  const acceptAttachedPty = (opened: HostAttachment): boolean => {
    if (disposed) {
      // dispose() closed the client; an explicit detach would race socket-close.
      return false;
    }
    pid = opened.ack.pid;
    // The host normally rejects exited entries as HOST_ATTACH_GONE; an exited
    // acknowledgement is defensive terminal evidence and must not be retried.
    if (opened.ack.exited) {
      emitDiagnostic("Station host PTY already exited.");
      emitExit({ exitCode: 1 });
      return false;
    }
    return true;
  };

  const prepareAttachmentForStreaming = async (
    opened: HostAttachment,
    state: AttachmentPreparationState,
  ): Promise<boolean> => {
    const isReconnect = state.replayed;
    await replayAttachmentSnapshot(opened, isReconnect);
    if (disposed) {
      return false;
    }
    // Failures after replay must clear before replaying the next ring snapshot.
    state.replayed = true;
    const attachSentSize = await synchronizeAttachmentGeometry(opened, isReconnect);
    if (disposed) {
      return false;
    }
    await drainPendingWrites(opened);
    if (disposed) {
      return false;
    }
    publishPreparedAttachment(opened, attachSentSize);
    return true;
  };

  const resolveAttachFailure = (
    error: unknown,
    state: AttachmentPreparationState,
    connectedAt: number | undefined,
  ): AttachAttemptOutcome => {
    if (disposed) {
      return { kind: "complete" };
    }
    const failure = classifyAttachmentFailure(error);
    emitDiagnostic(failure.message);
    if (failure.kind === "fatal") {
      emitExit({ exitCode: 1 });
      return { kind: "complete" };
    }
    return { kind: "reconnect", replayed: state.replayed, connectedAt };
  };

  const runAttachAttempt = async (
    ptyId: string,
    hadReplayed: boolean,
  ): Promise<AttachAttemptOutcome> => {
    const state: AttachmentPreparationState = { replayed: hadReplayed };
    // Stamped only after this attempt is ready to stream so setup failures do not
    // earn the healthy-connection retry reset.
    let connectedAt: number | undefined;
    try {
      const opened = await client.attach(ptyId);
      if (!acceptAttachedPty(opened)) {
        return { kind: "complete" };
      }
      if (!(await prepareAttachmentForStreaming(opened, state))) {
        return { kind: "complete" };
      }
      connectedAt = now();
      const stream = await consumeAttachmentFrames(opened);
      if (stream.kind === "exited") {
        emitExit(stream.exit);
        return { kind: "complete" };
      }
    } catch (error) {
      return resolveAttachFailure(error, state, connectedAt);
    }
    return { kind: "reconnect", replayed: state.replayed, connectedAt };
  };

  const prepareReconnect = async (
    attempt: number,
    connectedAt: number | undefined,
  ): Promise<ReconnectPreparationOutcome> => {
    // Invalidate pending resize acknowledgements from the detached generation
    // before clearing its published write path and confirmed geometry.
    resizeSeq += 1;
    attachment = undefined;
    ackedSize = undefined;
    if (disposed || closeRequested) {
      return { kind: "stop" };
    }

    let backoffAttempt = attempt;
    // A long-lived pane reconnects indefinitely, while a tight accept/drop flap
    // still exhausts the bounded budget instead of spinning forever.
    if (connectedAt !== undefined && now() - connectedAt > RECONNECT_MAX_MS) {
      backoffAttempt = -1;
    }
    if (backoffAttempt >= MAX_ATTACH_ATTEMPTS - 1) {
      return { kind: "exhausted" };
    }

    client.dispose();
    client = makeClient(options.hostSocketPath);
    emitDiagnostic("Station host connection lost; reconnecting…");
    await sleep(reconnectDelayMs(backoffAttempt));
    return { kind: "retry", attempt: backoffAttempt };
  };

  const advanceAttachLoop = async (
    ptyId: string,
    replayed: boolean,
    attempt: number,
  ): Promise<AttachLoopStep> => {
    const outcome = await runAttachAttempt(ptyId, replayed);
    if (outcome.kind === "complete") {
      return { kind: "complete" };
    }
    const reconnect = await prepareReconnect(attempt, outcome.connectedAt);
    switch (reconnect.kind) {
      case "stop":
        return { kind: "complete" };
      case "exhausted":
        return reconnect;
      case "retry":
        return { kind: "retry", attempt: reconnect.attempt, replayed: outcome.replayed };
      default:
        return unreachableAttachmentState(reconnect);
    }
  };

  // Retry only transient transport loss; permanent host evidence or exhaustion
  // ends the pane, while a healthy connection earns a fresh consecutive budget.
  const runAttachLoop = async (ptyId: string): Promise<void> => {
    let replayed = false;
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
      const step = await advanceAttachLoop(ptyId, replayed, attempt);
      if (step.kind === "complete") {
        return;
      }
      if (step.kind === "exhausted") {
        break;
      }
      replayed = step.replayed;
      attempt = step.attempt;
    }
    emitDiagnostic("Station host reconnect failed.");
    emitExit({ exitCode: 1 });
  };

  void (async () => {
    if (options.spawn !== undefined) {
      // Eagerly spawn the aux PTY at the laid-out size, then attach to it like any
      // other host PTY. Spawn runs ONCE — never inside the reconnect loop, where a
      // retry would fork a second PTY. The size rides in from the lazy first-resize.
      try {
        const spawned = await client.spawn({ ...options.spawn, cols: size.cols, rows: size.rows });
        resolvedPtyId = spawned.ptyId;
        pid = spawned.pid;
      } catch (error) {
        emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
        emitExit({ exitCode: 1 });
        return;
      }
      if (closeRequested) {
        // The pane was closed while the spawn was in flight: close what we just
        // created and never attach.
        closeOwnedPty();
        return;
      }
    }
    if (disposed) {
      return;
    }
    if (resolvedPtyId === undefined) {
      emitDiagnostic("Station host attach failed: no pty id.");
      emitExit({ exitCode: 1 });
      return;
    }
    await runAttachLoop(resolvedPtyId);
  })();

  const disposableFor = <T>(set: Set<T>, listener: T): StationTerminalDisposable => ({
    dispose: () => {
      set.delete(listener);
    },
  });

  return {
    id: options.spawn?.terminalTargetId ?? `host:${options.ptyId ?? "pending"}`,
    command: ownsPty ? "host-aux" : "host-agent",
    get pid() {
      return pid;
    },
    get size() {
      return size;
    },
    onData(listener) {
      dataListeners.add(listener);
      for (const data of pendingData) {
        listener(data);
      }
      pendingData.length = 0;
      return disposableFor(dataListeners, listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return disposableFor(exitListeners, listener);
    },
    onDiagnostic(listener) {
      diagnosticListeners.add(listener);
      return disposableFor(diagnosticListeners, listener);
    },
    onReplay(listener) {
      replayListeners.add(listener);
      return disposableFor(replayListeners, listener);
    },
    write(data) {
      if (disposed || exited) {
        return;
      }
      if (attachment === undefined) {
        pendingWrites.push(data);
        return;
      }
      // Surface a failed write as a diagnostic rather than dropping it silently.
      attachment.write(data).catch((error) => {
        emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
      });
    },
    resize(next) {
      size = next;
      // Applied (and acked) via applyHostResize; a no-op while detached, then
      // (re)sent by the attach loop once attachment is set.
      applyHostResize(next);
    },
    get ackedSize() {
      return ackedSize;
    },
    kill() {
      if (!ownsPty) {
        // An attached agent: its lifecycle is the observer's, so closing goes
        // through the observer-side provider (host.close), not this client.
        return;
      }
      if (resolvedPtyId === undefined) {
        // Spawn still in flight; close it as soon as we have the id.
        closeRequested = true;
        return;
      }
      closeOwnedPty();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      dataListeners.clear();
      exitListeners.clear();
      diagnosticListeners.clear();
      replayListeners.clear();
      // DETACH, never kill: closing this pane's connection makes the host release
      // the stream (its socket-close handler) while keeping the PTY alive for the
      // next reattach. (Each pane owns its own client/connection, so closing it
      // detaches only this pane.)
      client.dispose();
    },
  };
}
