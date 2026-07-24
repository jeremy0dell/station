import type { ScrollOnOutputMode } from "../../config/stationConfig.js";
import type { PaneId } from "../../state/types.js";
import { reportTerminalCorruption, writePaneEvidenceDump } from "../diagnostics.js";
import { createLocalPtyTerminal } from "../pty/localPtyTerminal.js";
import type {
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalSize,
  StationTerminalSpawnOptions,
} from "../types.js";
import { createStationVtScreen, type StationVtScreen } from "../vt/screen.js";

const DEFAULT_RESIZE_DEBOUNCE_MS = 75;
// Grace for the async resize path (debounce, bridge hop, host ack) before a
// screen/PTY/pane size disagreement counts as divergence rather than transit.
const GEOMETRY_SETTLE_MS = 2_000;

/**
 * The read-only view a pane id resolves to. `screen` and `terminal` are null
 * until the pane is first laid out (the lazy spawn-on-first-resize); `status`
 * tracks "starting shell" -> `pid N` -> exit text for the pane title.
 */
export type PtyRegistryEntry = {
  readonly paneId: PaneId;
  readonly screen: StationVtScreen | null;
  readonly terminal: StationTerminalProcess | null;
  readonly exited: boolean;
  readonly status: string;
  /**
   * The cwd captured on the first `ensure` (the *spawn* dir; it goes stale once
   * the shell `cd`s). Exposed so a split can inherit its anchor's directory and
   * so the layout snapshot can persist where each pane opened. `undefined` when
   * the entry was reserved without spawn options.
   */
  readonly cwd: string | undefined;
};

export type PtyRegistry = {
  /**
   * Allocate the bookkeeping for a pane. Idempotent, does NOT spawn a PTY, and
   * does NOT notify subscribers: `subscribe` tracks pane *liveness* (spawn,
   * exit, dispose), while pane *membership* is the coordination store's job.
   */
  ensure(
    paneId: PaneId,
    spawnOptions?: StationTerminalSpawnOptions,
    /**
     * Per-entry terminal creator (e.g. a host-attached terminal) used instead of
     * the registry default on the lazy first-resize spawn. Set on first `ensure`.
     */
    createTerminalOverride?: (options: StationTerminalSpawnOptions) => StationTerminalProcess,
  ): PtyRegistryEntry;
  get(paneId: PaneId): PtyRegistryEntry | undefined;
  has(paneId: PaneId): boolean;
  entries(): readonly PtyRegistryEntry[];
  /** Route input to a pane. Returns false when no live terminal is attached. */
  write(paneId: PaneId, bytes: string): boolean;
  /** Paste to a pane, wrapping per the pane's bracketed-paste state. */
  paste(paneId: PaneId, text: string): boolean;
  /** Debounced; spawns the PTY at the laid-out size on the first call. */
  resize(paneId: PaneId, size: StationTerminalSize): void;
  /** Structural/status changes (spawn, exit, dispose) — NOT screen content. */
  subscribe(listener: () => void): () => void;
  /**
   * Replace the pane-exit side effect. HMR can keep the registry and live PTYs
   * while recreating the app composition, so exits must report through the
   * current observer client instead of the callback captured at registry birth.
   */
  setPaneExitHandler(listener: ((paneId: PaneId) => void) | undefined): void;
  /**
   * Refresh defaults used by future lazy spawns. Existing live panes keep their
   * current terminal/screen semantics; HMR should not mutate a running shell.
   */
  setRuntimeOptions(options: PtyRegistryRuntimeOptions): void;
  dispose(paneId: PaneId): void;
  disposeAll(): void;
};

/** The registry without its lifecycle verbs — the surface handed to the React tree. */
export type PtyRegistryView = Pick<
  PtyRegistry,
  "get" | "has" | "entries" | "write" | "paste" | "resize" | "subscribe"
>;

export type PtyRegistryRuntimeOptions = {
  /** Default terminal creator for entries that do not supply an override. */
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /** Required so HMR can intentionally clear or change the default. */
  scrollOnOutput: ScrollOnOutputMode | undefined;
  /** Required so HMR refreshes the configured history depth for future lazy spawns. */
  scrollbackLines: number | undefined;
};

export type PtyRegistryOptions = {
  /** Test seam; production uses the local PTY bridge. */
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /** Normal-buffer history retained by screens created after this option is applied. */
  scrollbackLines?: number;
  /** Injectable for deterministic resize-debounce tests. */
  resizeDebounceMs?: number;
  /** Injectable for deterministic geometry-divergence tests. */
  geometrySettleMs?: number;
  /**
   * Notified when a pane's PTY process exits. Used to report a managed primary
   * agent's exit back to the observer. The registry knows only the pane id; the
   * composition maps it to the agent's terminal target.
   */
  onPaneExit?: (paneId: PaneId) => void;
  /** Scroll-position-on-output policy for every pane's screen; default freeze. */
  scrollOnOutput?: ScrollOnOutputMode;
};

type InternalEntry = {
  paneId: PaneId;
  screen: StationVtScreen | null;
  terminal: StationTerminalProcess | null;
  exited: boolean;
  spawnFailed: boolean;
  status: string;
  cwd: string | undefined;
  appliedSize: StationTerminalSize | null;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
  geometryCheckTimer: ReturnType<typeof setTimeout> | undefined;
  // True while a recorded snapshot is being parsed at its own size; the screen
  // is intentionally off pane size then, so the geometry check must not fire.
  replayingSnapshot: boolean;
  lastResizeAt: number;
  pendingSize: StationTerminalSize | null;
  spawnOptions: StationTerminalSpawnOptions | undefined;
  createTerminal: ((options: StationTerminalSpawnOptions) => StationTerminalProcess) | undefined;
  subscriptions: Array<{ dispose(): void }>;
};

/**
 * Runtime resource layer for pane PTYs and VT screens. The store keeps only pane
 * records; process handles and terminal buffers live here by pane id.
 */
export function createPtyRegistry(options: PtyRegistryOptions = {}): PtyRegistry {
  let createTerminal = options.createTerminal ?? createLocalPtyTerminal;
  let scrollOnOutput = options.scrollOnOutput;
  let scrollbackLines = options.scrollbackLines;
  const resizeDebounceMs = options.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
  const geometrySettleMs = options.geometrySettleMs ?? GEOMETRY_SETTLE_MS;
  const entries = new Map<PaneId, InternalEntry>();
  const listeners = new Set<() => void>();
  let onPaneExit = options.onPaneExit;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const ensureEntry = (
    paneId: PaneId,
    spawnOptions?: StationTerminalSpawnOptions,
    createTerminalOverride?: (options: StationTerminalSpawnOptions) => StationTerminalProcess,
  ): InternalEntry => {
    const existing = entries.get(paneId);
    if (existing !== undefined) {
      return existing;
    }
    const entry: InternalEntry = {
      paneId,
      screen: null,
      terminal: null,
      exited: false,
      spawnFailed: false,
      status: "starting shell",
      appliedSize: null,
      resizeTimer: undefined,
      geometryCheckTimer: undefined,
      replayingSnapshot: false,
      lastResizeAt: 0,
      pendingSize: null,
      spawnOptions,
      cwd: spawnOptions?.cwd,
      createTerminal: createTerminalOverride,
      subscriptions: [],
    };
    entries.set(paneId, entry);
    return entry;
  };

  // First-resize lazy spawn: create the screen at the laid-out size, then start
  // the PTY at that same size so there is no corrective resize/SIGWINCH during
  // shell startup, and so panes that are never laid out never spawn a shell.
  const startSession = (entry: InternalEntry, size: StationTerminalSize): void => {
    const screen = createStationVtScreen({
      size,
      ...(scrollOnOutput === undefined ? {} : { scrollOnOutput }),
      ...(scrollbackLines === undefined ? {} : { scrollback: scrollbackLines }),
      diagnosticsLabel: entry.paneId,
      onResponse: (data) => {
        // A replayed snapshot re-parses queries the child issued long ago
        // (startup probes recorded in the ring); answering those would inject
        // stale replies into the child's stdin, so drop replies until the
        // replay settles.
        if (entry.replayingSnapshot) {
          return;
        }
        // Query replies (DA1/DSR/OSC...) go straight to the PTY: routing them
        // through the keyboard path would tangle them with chord filtering,
        // and TUIs block on these at startup.
        const current = entries.get(entry.paneId);
        if (current?.terminal && !current.exited) {
          current.terminal.write(data);
        }
      },
    });
    entry.screen = screen;
    entry.appliedSize = size;
    // The pane border reads the title off the registry's structural notify, not
    // the screen's per-frame channel (only the renderable consumes that). Bridge
    // the screen's title-only signal onto notify so the border refreshes when the
    // title changes, without re-notifying every pane on each output frame.
    entry.subscriptions.push({ dispose: screen.onTitleChange(notify) });

    let terminal: StationTerminalProcess;
    try {
      const make = entry.createTerminal ?? createTerminal;
      terminal = make({ ...entry.spawnOptions, size });
    } catch (error) {
      entry.spawnFailed = true;
      entry.status = "failed to start shell";
      screen.feed(error instanceof Error ? error.message : "Failed to start shell.");
      notify();
      return;
    }
    entry.terminal = terminal;
    entry.status = `pid ${terminal.pid}`;
    // Covers PTYs diverged from birth (e.g. a host PTY spawned at a default
    // size); later resizes re-schedule their own checks.
    scheduleGeometryCheck(entry);
    if (terminal.onReplay !== undefined) {
      entry.subscriptions.push(
        terminal.onReplay(async ({ size: recordedSize, chunks }) => {
          const current = entry.screen;
          if (current === null) {
            return;
          }
          // Parse the snapshot at the size it was painted for — erase/cursor
          // sequences recorded at another width land on the wrong rows
          // otherwise — then return to the pane size so xterm reflows the
          // replayed rows. The terminal holds live frames until this resolves.
          entry.replayingSnapshot = true;
          try {
            current.resize(recordedSize);
            for (const chunk of chunks) {
              current.feed(chunk);
            }
            await current.whenIdle();
          } finally {
            entry.replayingSnapshot = false;
          }
          current.resize(entry.appliedSize ?? size);
          // Re-check now that the screen is back at pane size; a check that fired
          // during the replay was suppressed.
          scheduleGeometryCheck(entry);
        }),
      );
    }
    entry.subscriptions.push(
      // Transport faults (failed host resizes, reconnects) feed the divergence
      // detector; without a subscriber they would be dropped silently.
      terminal.onDiagnostic((message) => {
        reportTerminalCorruption({
          kind: "terminal_diagnostic",
          pane: entry.paneId,
          detail: { message },
        });
      }),
      terminal.onData((data) => {
        entry.screen?.feed(data);
      }),
      terminal.onExit((event) => {
        entry.exited = true;
        entry.status = formatExit(event);
        notify();
        onPaneExit?.(entry.paneId);
      }),
    );
    notify();
  };

  const applyResize = (entry: InternalEntry, size: StationTerminalSize): void => {
    entry.lastResizeAt = Date.now();
    entry.appliedSize = size;
    // Screen first: the app's SIGWINCH-triggered repaint then always meets an
    // already-resized emulator.
    entry.screen?.resize(size);
    if (!entry.exited) {
      entry.terminal?.resize(size);
    }
    scheduleGeometryCheck(entry);
  };

  // Divergence detector: after a resize settles, the pane's asserted size, the
  // screen model, and the PTY's acked size must agree. A persistent mismatch
  // is the stuck-width corruption observed directly, so it logs and captures
  // pane evidence.
  const scheduleGeometryCheck = (entry: InternalEntry): void => {
    if (entry.geometryCheckTimer !== undefined) {
      clearTimeout(entry.geometryCheckTimer);
    }
    entry.geometryCheckTimer = setTimeout(() => {
      entry.geometryCheckTimer = undefined;
      if (entries.get(entry.paneId) !== entry || entry.exited) {
        return;
      }
      // A pending resize or an in-flight replay intentionally holds the screen
      // off pane size; either would report a transient as divergence. The
      // resize path and the replay handler each re-schedule a check when they
      // settle, so skipping here loses no real signal.
      if (entry.replayingSnapshot || entry.resizeTimer !== undefined) {
        return;
      }
      const applied = entry.appliedSize;
      const stats = entry.screen?.bufferStats();
      const acked = entry.terminal?.ackedSize;
      if (applied === null || stats === undefined) {
        return;
      }
      const screenMismatch = stats.cols !== applied.cols || stats.rows !== applied.rows;
      const ackMismatch =
        acked !== undefined && (acked.cols !== applied.cols || acked.rows !== applied.rows);
      if (!screenMismatch && !ackMismatch) {
        return;
      }
      const sizes = {
        paneSize: `${applied.cols}x${applied.rows}`,
        screenSize: `${stats.cols}x${stats.rows}`,
        ...(acked === undefined ? {} : { ptySize: `${acked.cols}x${acked.rows}` }),
      };
      reportTerminalCorruption({
        kind: "geometry_divergence",
        pane: entry.paneId,
        detail: sizes,
      });
      const evidence = entry.screen?.corruptionEvidence();
      if (evidence !== undefined) {
        writePaneEvidenceDump({
          pane: entry.paneId,
          trigger: "geometry_divergence",
          evidence,
          detail: sizes,
        });
      }
    }, geometrySettleMs);
  };

  const disposeEntry = (entry: InternalEntry): void => {
    if (entry.resizeTimer !== undefined) {
      clearTimeout(entry.resizeTimer);
      entry.resizeTimer = undefined;
    }
    if (entry.geometryCheckTimer !== undefined) {
      clearTimeout(entry.geometryCheckTimer);
      entry.geometryCheckTimer = undefined;
    }
    for (const subscription of entry.subscriptions) {
      subscription.dispose();
    }
    entry.subscriptions = [];
    entry.terminal?.dispose();
    entry.screen?.dispose();
    entries.delete(entry.paneId);
  };

  return {
    ensure: (paneId, spawnOptions, createTerminalOverride) =>
      ensureEntry(paneId, spawnOptions, createTerminalOverride),
    get: (paneId) => entries.get(paneId),
    has: (paneId) => entries.has(paneId),
    entries: () => [...entries.values()],

    write: (paneId, bytes) => {
      const entry = entries.get(paneId);
      if (!entry?.terminal || entry.exited) {
        return false;
      }
      entry.terminal.write(bytes);
      return true;
    },

    paste: (paneId, text) => {
      const entry = entries.get(paneId);
      if (!entry?.terminal || entry.exited) {
        return false;
      }
      const bracketed = entry.screen?.isBracketedPasteEnabled() ?? false;
      entry.terminal.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
      return true;
    },

    resize: (paneId, size) => {
      const entry = ensureEntry(paneId);
      if (entry.screen === null) {
        startSession(entry, size);
        return;
      }
      if (size.cols === entry.appliedSize?.cols && size.rows === entry.appliedSize?.rows) {
        // Bounce-back to applied size must cancel pending resize—else stale intermediate lands on timer fire.
        entry.pendingSize = null;
        return;
      }
      entry.pendingSize = size;
      if (entry.resizeTimer !== undefined) {
        return;
      }
      // Leading edge for single resizes, trailing for drag storms.
      const elapsed = Date.now() - entry.lastResizeAt;
      const delay = elapsed >= resizeDebounceMs ? 0 : resizeDebounceMs - elapsed;
      entry.resizeTimer = setTimeout(() => {
        entry.resizeTimer = undefined;
        // A timer that fires after the pane was disposed must be a no-op.
        if (entry.pendingSize !== null && entries.get(paneId) === entry) {
          const pending = entry.pendingSize;
          entry.pendingSize = null;
          applyResize(entry, pending);
        }
      }, delay);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setPaneExitHandler: (listener) => {
      onPaneExit = listener;
    },

    setRuntimeOptions: (nextOptions) => {
      if (nextOptions.createTerminal !== undefined) {
        createTerminal = nextOptions.createTerminal;
      }
      scrollOnOutput = nextOptions.scrollOnOutput;
      scrollbackLines = nextOptions.scrollbackLines;
    },

    dispose: (paneId) => {
      const entry = entries.get(paneId);
      if (entry === undefined) {
        return;
      }
      disposeEntry(entry);
      notify();
    },

    disposeAll: () => {
      if (entries.size === 0) {
        return;
      }
      for (const entry of [...entries.values()]) {
        disposeEntry(entry);
      }
      notify();
    },
  };
}

function formatExit(event: StationTerminalExit): string {
  if (event.signal !== undefined && event.signal !== 0) {
    return `exited ${event.exitCode} signal ${event.signal}`;
  }
  return `exited ${event.exitCode}`;
}
