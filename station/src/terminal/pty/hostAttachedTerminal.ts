import {
  createStationHostClient,
  STATION_HOST_PROVIDER_ID,
  type HostAttachment,
  type HostSpawnParamsInput,
  type StationHostClient,
} from "@station/host";
import { type SafeErrorFallback, toSafeError } from "@station/observability";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
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
// so a blip doesn't permanently kill a pane whose PTY is still alive. These two
// host error codes mean the PTY is genuinely gone — those end the pane instead.
const MAX_ATTACH_ATTEMPTS = 6;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const PTY_GONE_CODES = new Set(["HOST_ATTACH_GONE", "HOST_PTY_NOT_FOUND"]);
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
    options.clientFactory ?? ((path) => createStationHostClient({ socketPath: path }));
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
  const pendingData: string[] = [];
  const pendingWrites: string[] = [];
  let attachment: HostAttachment | undefined;
  let size = options.size;
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

  // Attach, replay scrollback once, then stream frames. A transient transport
  // failure — or the stream ending with no exit frame — reconnects with backoff;
  // only a genuinely-gone PTY (or exhausted retries) ends the pane.
  const runAttachLoop = async (ptyId: string): Promise<void> => {
    let replayed = false;
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
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
        // Replay scrollback only on the FIRST successful attach: a reconnect must
        // not re-emit history into a client VT that already has it.
        if (!replayed) {
          for (const chunk of opened.ack.scrollback) {
            emitData(chunk);
          }
          replayed = true;
        }
        // Sync the host PTY to THIS client's pane size on (re)attach — the host may
        // have spawned it at a different size — then flush input typed before attach
        // resolved. Expose `attachment` only AFTER the flush so later writes order
        // after the buffered ones.
        await opened.resize(size.cols, size.rows);
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
        const safe = toSafeError(error, HOST_DATA_PLANE_FALLBACK);
        if (PTY_GONE_CODES.has(safe.code)) {
          emitDiagnostic(safe.message);
          emitExit({ exitCode: 1 });
          return;
        }
        emitDiagnostic(safe.message);
      }
      // Transient: clear attachment so write() re-buffers, then drop the dead
      // client and dial a fresh one before the next attempt.
      attachment = undefined;
      if (disposed || closeRequested) {
        return;
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
      if (attachment === undefined) {
        // Applied to the host PTY on attach via `size`.
        return;
      }
      attachment.resize(next.cols, next.rows).catch((error) => {
        emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
      });
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
      // DETACH, never kill: closing this pane's connection makes the host release
      // the stream (its socket-close handler) while keeping the PTY alive for the
      // next reattach. (Each pane owns its own client/connection, so closing it
      // detaches only this pane.)
      client.dispose();
    },
  };
}
