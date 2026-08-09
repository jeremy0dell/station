import type { UiRunContext } from "@station/contracts";
import {
  createStationHostClient,
  STATION_HOST_PROVIDER_ID,
  type HostAttachment,
  type HostFrame,
  type HostPtyRef,
  type HostSpawnParamsInput,
  type StationHostClient,
} from "@station/host";
import { type SafeErrorFallback, toSafeError } from "@station/observability";
import { stationBuildInfo } from "@station/runtime";
import { reportTerminalCorruption } from "../diagnostics.js";
import { CsiSequence } from "../protocol/csi.js";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalReplay,
  StationTerminalSize,
  StationTerminalUnavailable,
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
// host faults are classified as gone, unavailable, or retryable transport loss.
const MAX_ATTACH_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const PTY_GONE_CODES = new Set(["HOST_ATTACH_GONE", "HOST_PTY_NOT_FOUND"]);
const PTY_UNAVAILABLE_CODES = new Set([
  "HOST_ATTACHMENT_MISMATCH",
  "HOST_TARGET_CONFLICT",
  "HOST_SNAPSHOT_FAILED",
  "HOST_VERSION_INCOMPATIBLE",
  "HOST_CLIENT_IDENTITY_MISMATCH",
  "HOST_UPGRADE_BLOCKED",
  "HOST_BAD_REQUEST",
]);
// Reconnect repaint: cursor home, clear screen, clear scrollback. Lets us replay
// the fresh ring snapshot on reconnect (which holds output produced while we were
// detached) without stacking it on top of the history the VT already shows.
// Exported so the reconnect test can pin that it precedes the replayed snapshot.
export const RECONNECT_REPAINT =
  CsiSequence.CursorHome +
  CsiSequence.EraseEntireDisplay +
  CsiSequence.EraseScrollback;
const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const unreachableAttachmentState = (_value: never): never => {
  throw new Error("Unexpected Station Host attachment state.");
};

type AttachmentFailure =
  | { kind: "gone"; error: StationTerminalUnavailable }
  | { kind: "unavailable"; error: StationTerminalUnavailable }
  | { kind: "transient"; error: StationTerminalUnavailable };

type AttachmentStreamOutcome =
  | { kind: "disconnected" }
  | { kind: "exited"; exit: StationTerminalExit };

type AttachAttemptOutcome =
  | { kind: "complete" }
  | {
      kind: "reconnect";
      replayed: boolean;
      connectedAt: number | undefined;
      error?: StationTerminalUnavailable;
    };

type AttachmentPreparationState = { replayed: boolean };

type ReconnectPreparationOutcome =
  | { kind: "stop" }
  | { kind: "exhausted" }
  | { kind: "retry"; attempt: number };

type AttachLoopStep =
  | { kind: "complete" }
  | { kind: "exhausted"; error?: StationTerminalUnavailable }
  | { kind: "retry"; attempt: number; replayed: boolean; error?: StationTerminalUnavailable };

export type HostAttachedTerminalOptions = {
  hostSocketPath: string;
  /** Exact existing Host PTY lifetime. Required unless `spawn` is supplied. */
  ptyRef?: HostPtyRef;
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
  /** Renderer correlation captured once and reused across reconnect attempts. */
  uiContext?: UiRunContext;
  /** Test seam; production dials the host unix socket. */
  clientFactory?: (socketPath: string) => StationHostClient;
  /** Test seam for the reconnect-budget clock; production uses wall time. */
  now?: () => number;
  /** Test seam for reconnect waits; production uses wall-clock timers. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Host-attached `StationTerminalProcess`: attach, replay, then stream live
 * data and geometry frames. Degraded reconstruction replays the Host's
 * mode-restoring, cursor-anchoring reset data before requesting repaint and
 * keeps I/O live; proven PTY loss emits exit, while compatibility failures emit
 * unavailable. Every reconnect retains the same PTY reference while receiving
 * a fresh attachment-attempt identity. `dispose()` only detaches.
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
        ...(options.uiContext === undefined ? {} : { uiContext: options.uiContext }),
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
  const unavailableListeners = new Set<(event: StationTerminalUnavailable) => void>();
  const replayListeners = new Set<(replay: StationTerminalReplay) => void | Promise<void>>();
  const geometryListeners = new Set<
    (size: StationTerminalSize) => void | Promise<void>
  >();
  const pendingData: string[] = [];
  const pendingWrites: string[] = [];
  let attachment: HostAttachment | undefined;
  let size = options.size;
  // The size the host PTY last CONFIRMED applying (not the size we asked for);
  // a persistent gap between this and `size` is geometry divergence.
  let ackedSize: StationTerminalSize | undefined;
  let pid = 0;
  let exited = false;
  let unavailable = false;
  let lastUnavailable: StationTerminalUnavailable | undefined;
  let disposed = false;
  let resolvedPtyRef = options.ptyRef;
  let closeRequested = false;

  // Close an owned (aux) PTY on the host. Uses a SEPARATE short-lived client so
  // the request can't be cut off by dispose() tearing down the attach connection
  // in the same tick (a pane close fires kill() then, via reconcile, dispose()).
  const closeOwnedPty = (): void => {
    const id = resolvedPtyRef?.ptyId;
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
  const emitUnavailable = (event: StationTerminalUnavailable): void => {
    unavailable = true;
    lastUnavailable = event;
    attachment = undefined;
    ackedSize = undefined;
    pendingWrites.length = 0;
    for (const listener of unavailableListeners) {
      listener(event);
    }
  };
  // A wired replay listener gets the ordered production geometry and is awaited
  // so live frames never interleave with replay; legacy consumers receive data.
  const emitReplay = async (replay: StationTerminalReplay): Promise<void> => {
    if (disposed) {
      return;
    }
    if (replayListeners.size === 0) {
      for (const event of replay.events) {
        if (event.type === "data") {
          emitData(event.data);
        }
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
          return await listener(replay);
        } catch (error) {
          emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
          return;
        }
      }),
    );
  };

  const emitGeometry = async (next: StationTerminalSize): Promise<void> => {
    if (disposed) {
      return;
    }
    ackedSize = next;
    await Promise.all(
      [...geometryListeners].map(async (listener) => {
        try {
          return await listener(next);
        } catch (error) {
          emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
          return;
        }
      }),
    );
  };

  // Request a Host resize; the ordered stream barrier, not this RPC response,
  // confirms when subsequent data belongs to the new geometry.
  const applyHostResize = (target: StationTerminalSize): void => {
    const opened = attachment;
    if (opened === undefined) {
      return;
    }
    opened
      .resize(target.cols, target.rows)
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
    const hostReplay = opened.ack.replay;
    const replay: StationTerminalReplay = {
      initialSize: {
        cols: hostReplay.initialCols,
        rows: hostReplay.initialRows,
      },
      events:
        hostReplay.kind === "live-reset-recovery"
          ? [{ type: "data", data: hostReplay.resetData }]
          : hostReplay.events,
      kind: hostReplay.kind,
    };
    if (replay.kind === "live-reset-recovery") {
      reportTerminalCorruption({
        kind: "terminal_diagnostic",
        key: "host_live_reset_recovery",
        detail: {
          code: "HOST_SNAPSHOT_DEGRADED",
          ptyId: opened.ack.ptyId,
        },
      });
      emitDiagnostic(
        "Station reattached to the live terminal without historical output because exact replay was unavailable.",
      );
      await emitReplay(replay);
      return;
    }
    if (!isReconnect) {
      await emitReplay(replay);
      return;
    }
    if (replay.kind === "semantic-truncation-recovery") {
      await emitReplay(replay);
      return;
    }
    if (replay.events.some((event) => event.type === "data")) {
      await emitReplay({
        ...replay,
        events: [{ type: "data", data: RECONNECT_REPAINT }, ...replay.events],
      });
      return;
    }
    if (replay.events.length > 0) {
      await emitReplay(replay);
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
    const requiresChildRepaint =
      isReconnect ||
      opened.ack.replay.kind === "live-reset-recovery" ||
      opened.ack.replay.events.some((event) => event.type === "data");
    if (
      sizeUnchanged &&
      requiresChildRepaint &&
      opened.ack.cols === attachTarget.cols &&
      opened.ack.rows === attachTarget.rows
    ) {
      // Shrinking clamps alternate-buffer bottom-row cursors, so nudge upward before restoring.
      const nudgeTarget = {
        cols: attachTarget.cols,
        rows: attachTarget.rows + 1,
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
  };

  const consumeAttachmentFrames = async (
    iterator: AsyncIterator<HostFrame>,
  ): Promise<AttachmentStreamOutcome> => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        // No exit frame means the transport vanished while the host PTY may live.
        return { kind: "disconnected" };
      }
      const frame = next.value;
      switch (frame.type) {
        case "data":
          emitData(frame.data);
          break;
        case "resize":
          await emitGeometry({ cols: frame.cols, rows: frame.rows });
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
  };

  const classifyAttachmentFailure = (error: unknown): AttachmentFailure => {
    const safe = toSafeError(error, HOST_DATA_PLANE_FALLBACK);
    const classified = { code: safe.code, message: safe.message };
    if (PTY_GONE_CODES.has(safe.code)) {
      return { kind: "gone", error: classified };
    }
    if (PTY_UNAVAILABLE_CODES.has(safe.code)) {
      return { kind: "unavailable", error: classified };
    }
    return { kind: "transient", error: classified };
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
    emitDiagnostic(failure.error.message);
    if (failure.kind === "gone") {
      emitExit({ exitCode: 1 });
      return { kind: "complete" };
    }
    if (failure.kind === "unavailable") {
      emitUnavailable(failure.error);
      return { kind: "complete" };
    }
    return { kind: "reconnect", replayed: state.replayed, connectedAt, error: failure.error };
  };

  const runAttachAttempt = async (
    ptyRef: HostPtyRef,
    hadReplayed: boolean,
  ): Promise<AttachAttemptOutcome> => {
    const state: AttachmentPreparationState = { replayed: hadReplayed };
    // Stamped only after this attempt is ready to stream so setup failures do not
    // earn the healthy-connection retry reset.
    let connectedAt: number | undefined;
    try {
      const opened = await client.attach(ptyRef);
      if (!acceptAttachedPty(opened)) {
        return { kind: "complete" };
      }
      if (!(await prepareAttachmentForStreaming(opened, state))) {
        return { kind: "complete" };
      }
      connectedAt = now();
      const iterator = opened.frames[Symbol.asyncIterator]();
      const stream = await consumeAttachmentFrames(iterator);
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
    // Clear the published write path and confirmed geometry before reconnecting.
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
    ptyRef: HostPtyRef,
    replayed: boolean,
    attempt: number,
  ): Promise<AttachLoopStep> => {
    const outcome = await runAttachAttempt(ptyRef, replayed);
    if (outcome.kind === "complete") {
      return { kind: "complete" };
    }
    const reconnect = await prepareReconnect(attempt, outcome.connectedAt);
    switch (reconnect.kind) {
      case "stop":
        return { kind: "complete" };
      case "exhausted":
        return { ...reconnect, ...(outcome.error === undefined ? {} : { error: outcome.error }) };
      case "retry":
        return {
          kind: "retry",
          attempt: reconnect.attempt,
          replayed: outcome.replayed,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        };
      default:
        return unreachableAttachmentState(reconnect);
    }
  };

  // Retry only transient transport loss; permanent host evidence or exhaustion
  // ends the pane, while a healthy connection earns a fresh consecutive budget.
  const runAttachLoop = async (ptyRef: HostPtyRef): Promise<void> => {
    let replayed = false;
    let lastError: StationTerminalUnavailable | undefined;
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
      const step = await advanceAttachLoop(ptyRef, replayed, attempt);
      if (step.kind === "complete") {
        return;
      }
      if (step.kind === "exhausted") {
        lastError = step.error;
        break;
      }
      replayed = step.replayed;
      lastError = step.error;
      attempt = step.attempt;
    }
    const unavailable =
      lastError?.code === "HOST_SNAPSHOT_PENDING"
        ? lastError
        : {
            code: "HOST_UNREACHABLE",
            message: "Station host reconnect failed; PTY liveness is unknown.",
          };
    emitDiagnostic("Station host reconnect failed.");
    emitUnavailable(unavailable);
  };

  void (async () => {
    if (options.spawn !== undefined) {
      // Eagerly spawn the aux PTY at the laid-out size, then attach to it like any
      // other host PTY. Spawn runs ONCE — never inside the reconnect loop, where a
      // retry would fork a second PTY. The size rides in from the lazy first-resize.
      try {
        const spawned = await client.spawn({ ...options.spawn, cols: size.cols, rows: size.rows });
        resolvedPtyRef = {
          terminalTargetId: spawned.terminalTargetId,
          ptyId: spawned.ptyId,
          ptyInstanceId: spawned.ptyInstanceId,
        };
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
    if (resolvedPtyRef === undefined) {
      const event = {
        code: "HOST_INVALID_ATTACHMENT",
        message: "Station host attach failed: no canonical PTY reference.",
      };
      emitDiagnostic(event.message);
      emitUnavailable(event);
      return;
    }
    await runAttachLoop(resolvedPtyRef);
  })();

  const disposableFor = <T>(set: Set<T>, listener: T): StationTerminalDisposable => ({
    dispose: () => {
      set.delete(listener);
    },
  });

  return {
    id: options.spawn?.terminalTargetId ?? `host:${options.ptyRef?.ptyId ?? "pending"}`,
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
    onUnavailable(listener) {
      unavailableListeners.add(listener);
      if (lastUnavailable !== undefined) {
        listener(lastUnavailable);
      }
      return disposableFor(unavailableListeners, listener);
    },
    onReplay(listener) {
      replayListeners.add(listener);
      return disposableFor(replayListeners, listener);
    },
    onGeometry(listener) {
      geometryListeners.add(listener);
      return disposableFor(geometryListeners, listener);
    },
    write(data) {
      if (disposed || exited || unavailable) {
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
      if (unavailable) {
        return;
      }
      // Requested via applyHostResize and confirmed by the ordered stream frame;
      // a no-op while detached, then re-sent once attachment is published.
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
      if (resolvedPtyRef === undefined) {
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
      unavailableListeners.clear();
      replayListeners.clear();
      geometryListeners.clear();
      // DETACH, never kill: closing this pane's connection makes the host release
      // the stream (its socket-close handler) while keeping the PTY alive for the
      // next reattach. (Each pane owns its own client/connection, so closing it
      // detaches only this pane.)
      client.dispose();
    },
  };
}
