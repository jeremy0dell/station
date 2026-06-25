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
  const client = makeClient(options.hostSocketPath);
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

  void (async () => {
    try {
      if (options.spawn !== undefined) {
        // Eagerly spawn the aux PTY at the laid-out size, then attach to it like
        // any other host PTY. The size rides in from the lazy first-resize call.
        const spawned = await client.spawn({ ...options.spawn, cols: size.cols, rows: size.rows });
        resolvedPtyId = spawned.ptyId;
        pid = spawned.pid;
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
      const opened = await client.attach(resolvedPtyId);
      if (disposed) {
        // dispose() already closed the client connection; the host detaches via
        // socket-close. No explicit detach (it would race the closed connection).
        return;
      }
      pid = opened.ack.pid;
      for (const chunk of opened.ack.scrollback) {
        emitData(chunk);
      }
      // Sync the host PTY to THIS client's pane size on (re)attach — the host may
      // have spawned it at a different size — then flush input typed before attach
      // resolved. Expose `attachment` only AFTER the flush so later writes order
      // after the buffered ones.
      await opened.resize(size.cols, size.rows);
      for (const data of pendingWrites) {
        await opened.write(data);
      }
      pendingWrites.length = 0;
      attachment = opened;
      if (opened.ack.exited) {
        emitExit({ exitCode: 0 });
        return;
      }
      for await (const frame of opened.frames) {
        if (frame.type === "data") {
          emitData(frame.data);
        } else if (frame.type === "exit") {
          emitExit({
            exitCode: frame.exitCode ?? 0,
            ...(frame.signal === undefined || frame.signal === null ? {} : { signal: frame.signal }),
          });
          return;
        }
        // a "focus" frame is best-effort and has no terminal-output meaning here
      }
      // The stream ended with no exit frame and we did not dispose: the host
      // connection dropped while the agent may still be alive. Surface it rather
      // than leaving the pane silently frozen.
      if (!disposed) {
        emitDiagnostic("Station host connection lost.");
        emitExit({ exitCode: 1 });
      }
    } catch (error) {
      emitDiagnostic(toSafeError(error, HOST_DATA_PLANE_FALLBACK).message);
      emitExit({ exitCode: 1 });
    }
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
