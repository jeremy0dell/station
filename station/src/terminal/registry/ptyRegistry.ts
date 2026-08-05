import type { ScrollOnOutputMode } from "../../config/stationConfig.js";
import type { PaneId } from "../../state/types.js";
import type { StationTerminalTheme } from "../../theme/index.js";
import { reportTerminalCorruption, writePaneEvidenceDump } from "../diagnostics.js";
import { BracketedPasteMarker } from "../protocol/csi.js";
import { createLocalPtyTerminal } from "../pty/localPtyTerminal.js";
import {
  createPtyOutputCompatibility,
  type PtyOutputCompatibility,
} from "../ptyOutputCompatibility.js";
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
  /** Proven process exit; the only local state that authorizes managed-pane recycling. */
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

export type PtyRegistryResetExitedResult =
  | { kind: "reset"; viewport: StationTerminalSize }
  | { kind: "refused"; reason: "missing" | "superseded" | "not-exited" };

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
  /**
   * Replaces only the exact exited entry captured by the caller, without notifying
   * before the caller publishes replacement identity. The new entry stays lazy;
   * the caller must resize it with the returned viewport to start its PTY.
   */
  resetExited(
    expectedEntry: PtyRegistryEntry,
    spawnOptions: StationTerminalSpawnOptions,
    createTerminalOverride?: (options: StationTerminalSpawnOptions) => StationTerminalProcess,
  ): PtyRegistryResetExitedResult;
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
   * Fan one terminal-semantic projection to existing screens and remember it
   * for future lazy screens. This repaints emulator output only: it never
   * mutates, resizes, writes to, signals, replaces, or respawns a PTY.
   */
  updateTerminalTheme(theme: StationTerminalTheme): void;
  /**
   * Replace the pane-exit side effect. HMR can keep the registry and live PTYs
   * while recreating the app composition, so exits must report through the
   * current observer client instead of the callback captured at registry birth.
   */
  setPaneExitHandler(listener: ((paneId: PaneId) => void) | undefined): void;
  /**
   * Refresh process and scroll defaults used by future lazy spawns. Existing
   * live shells keep those semantics; live visual projection updates use
   * `updateTerminalTheme` instead.
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
  /** Required so HMR refreshes the bounded history depth for future lazy spawns. */
  scrollbackLines: number | undefined;
};

export type PtyRegistryOptions = {
  /** Test seam; production uses the local PTY bridge. */
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /** Bounded normal-buffer history retained by screens created after this option is applied. */
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
  unavailable: boolean;
  spawnFailed: boolean;
  status: string;
  cwd: string | undefined;
  appliedSize: StationTerminalSize | null;
  resizeTimer: ReturnType<typeof setTimeout> | undefined;
  // Serializes local resizes after queued old-width output has finished parsing.
  resizeTask: Promise<void> | undefined;
  geometryCheckTimer: ReturnType<typeof setTimeout> | undefined;
  // True while a recorded snapshot is being parsed at its own size; the screen
  // is intentionally off pane size then, so the geometry check must not fire.
  replayingSnapshot: boolean;
  lastResizeAt: number;
  pendingSize: StationTerminalSize | null;
  lastRequestedSize: StationTerminalSize | null;
  spawnOptions: StationTerminalSpawnOptions | undefined;
  outputCompatibility: PtyOutputCompatibility;
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
  let terminalTheme: StationTerminalTheme | undefined;
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
      unavailable: false,
      spawnFailed: false,
      status: "starting shell",
      appliedSize: null,
      resizeTimer: undefined,
      resizeTask: undefined,
      geometryCheckTimer: undefined,
      replayingSnapshot: false,
      lastResizeAt: 0,
      pendingSize: null,
      lastRequestedSize: null,
      spawnOptions,
      outputCompatibility: createPtyOutputCompatibility(spawnOptions?.outputCompatibility),
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
      ...(terminalTheme === undefined ? {} : { theme: terminalTheme }),
      diagnosticsLabel: entry.paneId,
      onResponse: (data) => {
        // A replayed snapshot re-parses queries the child issued long ago
        // (startup probes recorded in the ring); answering those would inject
        // stale replies into the child's stdin, so drop replies until the
        // replay settles.
        if (entries.get(entry.paneId) !== entry || entry.replayingSnapshot) {
          return;
        }
        // Query replies (DA1/DSR/OSC...) go straight to the PTY: routing them
        // through the keyboard path would tangle them with chord filtering,
        // and TUIs block on these at startup.
        if (entry.terminal !== null && !entry.exited) {
          entry.terminal.write(data);
        }
      },
    });
    entry.screen = screen;
    entry.appliedSize = size;
    // The pane border reads the title off the registry's structural notify, not
    // the screen's per-frame channel (only the renderable consumes that). Bridge
    // the screen's title-only signal onto notify so the border refreshes when the
    // title changes, without re-notifying every pane on each output frame.
    entry.subscriptions.push({
      dispose: screen.onTitleChange(() => {
        if (entries.get(entry.paneId) === entry) {
          notify();
        }
      }),
    });

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
        terminal.onReplay(async ({ initialSize, events }) => {
          if (entries.get(entry.paneId) !== entry) {
            return;
          }
          const current = entry.screen;
          if (current === null) {
            return;
          }
          // Parse each retained segment at its production geometry; erase,
          // cursor, and wrapping semantics cannot be reconstructed at one width.
          // The terminal holds live frames until this resolves.
          entry.replayingSnapshot = true;
          try {
            current.resize(initialSize);
            for (const event of events) {
              if (event.type === "data") {
                current.feed(event.data);
                continue;
              }
              await current.whenIdle();
              if (entries.get(entry.paneId) !== entry) {
                return;
              }
              current.resize({ cols: event.cols, rows: event.rows });
            }
            await current.whenIdle();
          } finally {
            entry.replayingSnapshot = false;
          }
          if (entries.get(entry.paneId) !== entry) {
            return;
          }
          if (terminal.onGeometry === undefined) {
            current.resize(entry.appliedSize ?? size);
          }
          // Local replay returns to pane size above; ordered Host replay stays at
          // its final geometry until the queued live barrier is consumed.
          scheduleGeometryCheck(entry);
        }),
      );
    }
    if (terminal.onGeometry !== undefined) {
      entry.subscriptions.push(
        terminal.onGeometry(async (nextSize) => {
          if (entries.get(entry.paneId) !== entry) {
            return;
          }
          const current = entry.screen;
          if (current === null) {
            return;
          }
          // Complete older writes before applying the ordered barrier; the Host
          // awaits this callback before it emits data for the new geometry.
          await current.whenIdle();
          if (entries.get(entry.paneId) !== entry) {
            return;
          }
          current.resize(nextSize);
          scheduleGeometryCheck(entry);
        }),
      );
    }
    if (terminal.onUnavailable !== undefined) {
      entry.subscriptions.push(
        terminal.onUnavailable((event) => {
          if (entries.get(entry.paneId) !== entry) {
            return;
          }
          entry.unavailable = true;
          entry.status = "attachment unavailable";
          reportTerminalCorruption({
            kind: "terminal_diagnostic",
            pane: entry.paneId,
            detail: { code: event.code, message: event.message },
          });
          notify();
        }),
      );
    }
    entry.subscriptions.push(
      // Transport faults (failed host resizes, reconnects) feed the divergence
      // detector; without a subscriber they would be dropped silently.
      terminal.onDiagnostic((message) => {
        if (entries.get(entry.paneId) !== entry) {
          return;
        }
        reportTerminalCorruption({
          kind: "terminal_diagnostic",
          pane: entry.paneId,
          detail: { message },
        });
      }),
      terminal.onData((data) => {
        if (entries.get(entry.paneId) !== entry) {
          return;
        }
        const current = entry.screen;
        if (current === null) {
          return;
        }
        current.feed(
          entry.outputCompatibility.transform(data, current.bufferStats().rows).data,
        );
      }),
      terminal.onExit((event) => {
        if (entries.get(entry.paneId) !== entry || entry.exited) {
          return;
        }
        entry.screen?.feed(entry.outputCompatibility.flush());
        entry.exited = true;
        entry.status = formatExit(event);
        notify();
        onPaneExit?.(entry.paneId);
      }),
    );
    notify();
  };

  const applyResize = (entry: InternalEntry, size: StationTerminalSize): void => {
    const apply = (resizeScreen: boolean): void => {
      if (entries.get(entry.paneId) !== entry || entry.exited) {
        return;
      }
      entry.lastResizeAt = Date.now();
      entry.appliedSize = size;
      if (resizeScreen) {
        entry.screen?.resize(size);
      }
      if (!entry.unavailable) {
        entry.terminal?.resize(size);
      }
      scheduleGeometryCheck(entry);
    };

    if (entry.unavailable) {
      apply(true);
      return;
    }
    if (entry.terminal?.onGeometry !== undefined) {
      apply(false);
      return;
    }

    const previous = entry.resizeTask ?? Promise.resolve();
    const task = previous.then(async () => {
      const current = entry.screen;
      if (entries.get(entry.paneId) !== entry || entry.exited || current === null) {
        return;
      }
      // Finish old-width output, including any compatibility carry, before the
      // emulator resizes and the local PTY receives SIGWINCH.
      current.feed(entry.outputCompatibility.flush());
      await current.whenIdle();
      apply(true);
    });
    entry.resizeTask = task;
    const clearTask = (): void => {
      if (entry.resizeTask === task) {
        entry.resizeTask = undefined;
      }
    };
    void task.then(clearTask, clearTask);
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
      if (entries.get(entry.paneId) !== entry || entry.exited || entry.unavailable) {
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
    if (entries.get(entry.paneId) === entry) {
      entries.delete(entry.paneId);
    }
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
  };

  return {
    ensure: (paneId, spawnOptions, createTerminalOverride) =>
      ensureEntry(paneId, spawnOptions, createTerminalOverride),
    resetExited: (expectedEntry, spawnOptions, createTerminalOverride) => {
      const current = entries.get(expectedEntry.paneId);
      if (current === undefined) {
        return { kind: "refused", reason: "missing" };
      }
      if (current !== expectedEntry) {
        return { kind: "refused", reason: "superseded" };
      }
      if (!current.exited) {
        return { kind: "refused", reason: "not-exited" };
      }
      const viewport = current.lastRequestedSize ?? current.appliedSize;
      if (viewport === null) {
        return { kind: "refused", reason: "not-exited" };
      }
      disposeEntry(current);
      ensureEntry(current.paneId, spawnOptions, createTerminalOverride);
      return { kind: "reset", viewport };
    },
    get: (paneId) => entries.get(paneId),
    has: (paneId) => entries.has(paneId),
    entries: () => [...entries.values()],

    write: (paneId, bytes) => {
      const entry = entries.get(paneId);
      if (!entry?.terminal || entry.exited || entry.unavailable) {
        return false;
      }
      entry.terminal.write(bytes);
      return true;
    },

    paste: (paneId, text) => {
      const entry = entries.get(paneId);
      if (!entry?.terminal || entry.exited || entry.unavailable) {
        return false;
      }
      const bracketed = entry.screen?.isBracketedPasteEnabled() ?? false;
      entry.terminal.write(
        bracketed
          ? `${BracketedPasteMarker.Start}${text}${BracketedPasteMarker.End}`
          : text,
      );
      return true;
    },

    resize: (paneId, size) => {
      const entry = ensureEntry(paneId);
      entry.lastRequestedSize = size;
      if (entry.screen === null) {
        startSession(entry, size);
        return;
      }
      if (entry.exited) {
        return;
      }
      if (
        entry.resizeTask === undefined &&
        size.cols === entry.appliedSize?.cols &&
        size.rows === entry.appliedSize?.rows
      ) {
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

    updateTerminalTheme: (theme) => {
      const updates = [...entries.values()].flatMap((entry) =>
        entry.screen === null ? [] : [entry.screen.prepareTerminalThemeUpdate(theme)],
      );
      terminalTheme = theme;
      // Publish every complete projection before any repaint listener can observe another screen.
      for (const update of updates) {
        update.publish();
      }
      for (const update of updates) {
        update.invalidate();
      }
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
