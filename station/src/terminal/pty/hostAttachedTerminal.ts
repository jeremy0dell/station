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
      .catch(() => {})
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
          await listener({ size: recordedSize, chunks });
        } catch (error) {
          emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
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

  // Attach, replay scrollback once, then stream frames. A transient transport
  // failure — or the stream ending with no exit frame — reconnects with backoff;
  // only a genuinely-gone PTY (or exhausted retries) ends the pane.
  const runAttachLoop = async (ptyId: string): Promise<void> => {
    let replayed = false;
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
      // Stamped once this attempt actually streams; a connection that outlives
      // the backoff window earns a fresh retry budget below (see the reset).
      let connectedAt: number | undefined;
      try {
        const opened = await client.attach(ptyId);
        if (disposed) {
          // dispose() already closed the client connection; the host detaches via
          // socket-close. No explicit detach (it would race the closed connection).
          return;
        }
        pid = opened.ack.pid;
        // Defensive: the host deletes exited entries, so attach normally throws
        // HOST_ATTACH_GONE rather than acking exited. Don't fabricate a clean exit
        // and don't retry.
        if (opened.ack.exited) {
          emitDiagnostic("Station host PTY already exited.");
          emitExit({ exitCode: 1 });
          return;
        }
        // First successful attach: replay the snapshot into the fresh client VT.
        // On a RECONNECT the ack snapshot is the current ring — it captured output
        // produced while we were detached — so repaint from it (clearing first so
        // the already-shown history isn't duplicated) rather than dropping the gap.
        const isReconnect = replayed;
        const recordedSize = { cols: opened.ack.cols, rows: opened.ack.rows };
        if (!replayed) {
          await emitReplay(opened.ack.scrollback, recordedSize);
          replayed = true;
        } else if (opened.ack.scrollback.length > 0) {
          await emitReplay([RECONNECT_REPAINT, ...opened.ack.scrollback], recordedSize);
        }
        // else: reconnect with an empty ring — clearing would just blank the pane
        // with nothing to replay, so leave the shown frame and rely on the nudge.
        // Sync the host PTY to THIS client's pane size on (re)attach — the host may
        // have spawned it at a different size — then flush input typed before attach
        // resolved. Expose `attachment` only AFTER the flush so later writes order
        // after the buffered ones.
        await opened.resize(size.cols, size.rows);
        // A same-size resize is a no-op TIOCSWINSZ — no SIGWINCH — so a child
        // whose frame may be stale would never repaint; flap the rows to force
        // one. Needed whenever there was history to reflow OR this is a reconnect
        // (the child may have produced state while we were detached). A real size
        // change above already delivers the signal.
        if (
          (isReconnect || opened.ack.scrollback.length > 0) &&
          opened.ack.cols === size.cols &&
          opened.ack.rows === size.rows
        ) {
          await opened.resize(size.cols, size.rows > 1 ? size.rows - 1 : size.rows + 1);
          await opened.resize(size.cols, size.rows);
        }
        // The size the host was just driven to; a resize arriving during the
        // write drain below only updates `size` (resize() no-ops while detached).
        const attachSentSize: StationTerminalSize = { cols: size.cols, rows: size.rows };
        // Drain front-to-back so a mid-flush failure leaves only the un-sent
        // writes to retry (no double-send on reconnect). New writes keep arriving
        // at the back while attachment is still undefined, preserving order.
        while (pendingWrites.length > 0) {
          const data = pendingWrites[0];
          if (data === undefined) {
            break;
          }
          await opened.write(data);
          pendingWrites.shift();
        }
        attachment = opened;
        if (size.cols !== attachSentSize.cols || size.rows !== attachSentSize.rows) {
          // A resize arrived during attach; resize() no-op'd then, so send it now.
          applyHostResize(size);
        } else {
          // Host is at the size we just drove it to; record it as confirmed.
          ackedSize = attachSentSize;
        }
        connectedAt = now();
        for await (const frame of opened.frames) {
          if (frame.type === "data") {
            emitData(frame.data);
          } else if (frame.type === "exit") {
            emitExit({
              exitCode: frame.exitCode ?? 0,
              ...(frame.signal === undefined || frame.signal === null
                ? {}
                : { signal: frame.signal }),
            });
            return;
          }
          // a "focus" frame is best-effort and has no terminal-output meaning here
        }
        // Stream ended with no exit frame: the host dropped our connection while
        // the PTY may still be alive. Fall through to reconnect.
      } catch (error) {
        if (disposed) {
          return;
        }
        const compatibilityFailure = isStationHostCompatibilityError(error);
        const safe = toSafeError(error, HOST_DATA_PLANE_FALLBACK);
        if (PTY_GONE_CODES.has(safe.code) || compatibilityFailure) {
          emitDiagnostic(safe.message);
          emitExit({ exitCode: 1 });
          return;
        }
        emitDiagnostic(safe.message);
      }
      // Transient: clear attachment so write() re-buffers, then drop the dead
      // client and dial a fresh one before the next attempt. Clear ackedSize so
      // a geometry check during the reconnect window does not read a stale ack.
      attachment = undefined;
      ackedSize = undefined;
      if (disposed || closeRequested) {
        return;
      }
      // Flap-safe budget reset: a connection that outlived the max backoff window
      // was healthy, so a later drop earns a FRESH retry budget — a long-lived
      // pane reconnects indefinitely across host restarts. A tight accept-then-
      // drop flap (shorter than the window) does NOT reset, so it still exhausts
      // the budget and ends the pane rather than spinning forever.
      if (connectedAt !== undefined && now() - connectedAt > RECONNECT_MAX_MS) {
        attempt = -1;
      }
      if (attempt < MAX_ATTACH_ATTEMPTS - 1) {
        client.dispose();
        client = makeClient(options.hostSocketPath);
        emitDiagnostic("Station host connection lost; reconnecting…");
        await delay(reconnectDelayMs(attempt));
      }
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
