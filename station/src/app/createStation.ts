import { setTuiWidgetsInConfig } from "@station/config";
import type { TuiStore } from "@station/dashboard-core";
import { safeErrorFromUnknown } from "@station/runtime";
import type { StoreApi } from "zustand/vanilla";
import type { Automation } from "../config/stationConfig.js";
import {
  type ClipboardEffects,
  copyToClipboard,
  copyToastMessage,
  DEFAULT_COPY_SINKS,
} from "../copy/clipboard.js";
import { createStationInputRuntime, type StationInputRuntime } from "../input/stationInput.js";
import { buildLayoutSnapshot } from "../state/layout/layoutSnapshot.js";
import {
  createLayoutWriter,
  writeLayoutSnapshotSync,
  type LayoutWriter,
} from "../state/layout/layoutPersistence.js";
import { createOverlayRowFocusReconciler } from "../state/reconcilers/overlayRowFocus.js";
import { createPaneReconciler } from "../state/reconcilers/reconcilePanes.js";
import { createSessionReaper } from "../state/reconcilers/sessionReaper.js";
import { selectPaneRecord } from "../state/selectors.js";
import type { StationStore } from "../state/store.js";
import type { PaneId } from "../state/types.js";
import type { StationClient } from "../sources/types.js";
import { resolveAuxShellPlacement } from "../terminal/pty/auxShellPlacement.js";
import { createStationHostManagedTerminalAttacher } from "../terminal/pty/managedTerminalAttacher.js";
import { createPtyRegistry, type PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { createStationViewStore } from "../station/store/stationViewStore.js";
import type { CreateStationOptions, Station, StationAppProps } from "./types.js";

/**
 * Wire Station's runtime — registry, source→store reconcilers, layout
 * persistence, lifecycle, and input — and hand back the view props plus a
 * start/dispose surface. The renderer (main.tsx / tests) mounts <StationApp />.
 *
 * Reads as a sequence of steps; each is one extracted helper below.
 */
export function createStation(options: CreateStationOptions): Station {
  const { store, stationClient } = options;
  const automations = options.automations ?? [];

  // The view store and live-PTY registry everything else wires around. The
  // config widget set seeds the store's live session copy; widget-settings
  // edits are written back to config.toml when a config path exists.
  const stationViewStore = createStationViewStore(stationClient, {
    ...(options.tuiConfig?.widgets === undefined ? {} : { widgets: options.tuiConfig.widgets }),
    widgetsPersisted: options.tuiConfigPath !== undefined,
  });
  const registry = setupRegistry(options, store, stationClient);

  // Source → store/registry bridges, plus debounced disk layout (production only).
  const reconcilers = createReconcilers(store, registry, stationClient);
  const layoutWriter = createLayoutPersistence(options, store, registry);

  // start()/dispose() own the subscription handles opened at start.
  const lifecycle = createLifecycle({
    store,
    stationClient,
    stationViewStore,
    registry,
    reconcilers,
    layoutWriter,
    tuiConfigPath: options.tuiConfigPath,
  });

  // Input runtime; its shutdown tears down this composition, then exits the app.
  const stationInput = createInputRuntime(options, {
    store,
    stationViewStore,
    registry,
    observerService: stationClient.service,
    automations,
    onShutdown: () => {
      lifecycle.disposeForShutdown();
      options.shutdown();
    },
  });

  const viewProps = buildViewProps(options, {
    store,
    registry,
    stationViewStore,
    dispatchMouse: stationInput.dispatchMouse,
    onCopySelection: createCopySelectionHandler(store, options.clipboardEffects),
    automations,
  });

  return {
    viewProps,
    store,
    registry,
    stationViewStore,
    stationInput,
    start: lifecycle.start,
    dispose: lifecycle.disposeForShutdown,
    disposeForShutdown: lifecycle.disposeForShutdown,
    disposeForHotReload: lifecycle.disposeForHotReload,
  };
}

// Re-exported so a single import yields both the runtime and its view.
export { StationApp } from "./StationApp.js";
export type { CreateStationOptions, Station, StationAppProps } from "./types.js";

type Reconcilers = { reconcile: () => void; reapRemovedSessions: () => void };

/** Create-or-reuse the PTY registry and bind it to this boot's spawn config. */
function setupRegistry(
  options: CreateStationOptions,
  store: StationStore,
  stationClient: StationClient,
): PtyRegistry {
  // When a managed primary agent's PTY exits, tell the observer to drop the
  // session (the local pane record stays until the user closes it). Best-effort:
  // a failed report falls to a staleness sweep. Shells (no identity) are ignored.
  const reportPaneExit = (paneId: PaneId): void => {
    const identity = selectPaneRecord(store.getState(), paneId)?.agentIdentity;
    if (identity === undefined) {
      return;
    }
    void stationClient.service
      .reportExternalExit({ terminalTargetId: identity.terminalTargetId })
      .catch(() => {});
  };
  const registry =
    options.registry ??
    createPtyRegistry({
      createTerminal: options.createTerminal,
      onPaneExit: reportPaneExit,
      ...(options.scrollOnOutput === undefined ? {} : { scrollOnOutput: options.scrollOnOutput }),
    });
  // Refresh a (possibly HMR-reused) registry to this boot's config; createTerminal
  // is left untouched when omitted, so a reused registry keeps its live terminal creator.
  registry.setRuntimeOptions({
    ...(options.createTerminal === undefined ? {} : { createTerminal: options.createTerminal }),
    scrollOnOutput: options.scrollOnOutput,
  });
  registry.setPaneExitHandler(reportPaneExit);
  return registry;
}

/** The two source→store/registry reconcilers the lifecycle subscribes at start. */
function createReconcilers(
  store: StationStore,
  registry: PtyRegistry,
  stationClient: StationClient,
): Reconcilers {
  const reconcile = createPaneReconciler(store, registry);
  // Close a session's panes when the observer drops it: feed the reaper observer
  // truth (live session ids + instance) and a kill seam; it owns the reap logic
  // and the launch-race / observer-restart guards.
  const reapRemovedSessions = createSessionReaper({
    store,
    liveSessionIds: () => {
      const snapshot = stationClient.state.getState().snapshot;
      return snapshot === undefined ? undefined : new Set(snapshot.sessions.map((s) => s.id));
    },
    observerInstanceId: () => {
      const observer = stationClient.state.getState().snapshot?.observer;
      return observer === undefined ? undefined : `${observer.pid}:${observer.startedAt}`;
    },
    killPane: (paneId) => registry.get(paneId)?.terminal?.kill(),
  });
  return { reconcile, reapRemovedSessions };
}

/** Debounced disk layout writer, or undefined when persistence is unconfigured. */
function createLayoutPersistence(
  options: CreateStationOptions,
  store: StationStore,
  registry: PtyRegistry,
): LayoutWriter | undefined {
  const { layout } = options;
  if (layout === undefined) {
    return undefined;
  }
  // A host-attached pane's terminalTargetId rides on its primary-agent record;
  // plain local shells have none.
  const targetForPane = (paneId: PaneId): string | undefined =>
    selectPaneRecord(store.getState(), paneId)?.agentIdentity?.terminalTargetId;
  // The store owns the records, the registry owns each pane's cwd; join them here.
  return createLayoutWriter({
    build: () =>
      buildLayoutSnapshot(
        store.getState().workspace,
        (paneId) => registry.get(paneId)?.cwd,
        targetForPane,
      ),
    write: layout.write ?? ((snapshot) => writeLayoutSnapshotSync(layout.path, snapshot)),
    ...(layout.debounceMs === undefined ? {} : { debounceMs: layout.debounceMs }),
  });
}

/** Own the subscription handles: open them on start, release them on dispose. */
function createLifecycle(deps: {
  store: StationStore;
  stationClient: StationClient;
  stationViewStore: StoreApi<TuiStore>;
  registry: PtyRegistry;
  reconcilers: Reconcilers;
  layoutWriter: LayoutWriter | undefined;
  tuiConfigPath: string | undefined;
}): Pick<Station, "start" | "disposeForShutdown" | "disposeForHotReload"> {
  const {
    store,
    stationClient,
    stationViewStore,
    registry,
    reconcilers,
    layoutWriter,
    tuiConfigPath,
  } = deps;
  let detachStationSource: (() => void) | undefined;
  let detachOverlayRowFocus: (() => void) | undefined;
  let detachReconcile: (() => void) | undefined;
  let detachSessionReconcile: (() => void) | undefined;
  let detachLayoutWriter: (() => void) | undefined;
  let detachWidgetConfigWrites: (() => void) | undefined;
  let disposed = false;

  const disposeInternal = (disposeTerminals: boolean): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    detachOverlayRowFocus?.();
    detachOverlayRowFocus = undefined;
    detachStationSource?.();
    detachStationSource = undefined;
    detachReconcile?.();
    detachReconcile = undefined;
    detachSessionReconcile?.();
    detachSessionReconcile = undefined;
    detachLayoutWriter?.();
    detachLayoutWriter = undefined;
    detachWidgetConfigWrites?.();
    detachWidgetConfigWrites = undefined;
    // Real shutdown flushes pending layout synchronously (process.exit follows);
    // an HMR teardown just drops the timer — the reused store/registry keep it.
    if (disposeTerminals) {
      layoutWriter?.flush();
    } else {
      layoutWriter?.dispose();
    }
    // Deliberately keep the registry's pane-exit handler: across an HMR reload Bun
    // may run this dispose AFTER the next composition installed its handler, so
    // clearing would strand managed-agent exits. The next composition reinstalls
    // its own, and shutdown disposes the registry outright.
    void stationClient.stop();
    // React unmount work scheduled during shutdown can't flush before exit, so
    // live PTYs are disposed imperatively.
    if (disposeTerminals) {
      registry.disposeAll();
    }
  };

  return {
    start: (): void => {
      disposed = false;
      // Seed the registry from the initial workspace and keep it reconciled.
      reconcilers.reconcile();
      detachReconcile = store.subscribe(reconcilers.reconcile);
      // Seed once so a warm-restored agent's live session is recorded before any
      // later removal, then reap on every observer update.
      reconcilers.reapRemovedSessions();
      detachSessionReconcile = stationClient.state.subscribe(reconcilers.reapRemovedSessions);
      // Persist on every structural/focus change (debounced). Writing the seeded
      // layout once now means a restored session re-persists immediately, so a
      // second restart is a no-op rather than a regression.
      if (layoutWriter !== undefined) {
        layoutWriter.schedule();
        detachLayoutWriter = store.subscribe(() => layoutWriter.schedule());
      }
      if (tuiConfigPath !== undefined) {
        detachWidgetConfigWrites = startWidgetConfigWrites(stationViewStore, tuiConfigPath);
      }
      detachStationSource = stationViewStore.getState().start();
      // The overlay bridge may synchronize immediately, so its dashboard source
      // subscription must already be active before the bridge starts.
      detachOverlayRowFocus = createOverlayRowFocusReconciler(store, stationViewStore);
      stationClient.start();
    },
    disposeForShutdown: (): void => disposeInternal(true),
    disposeForHotReload: (): void => disposeInternal(false),
  };
}

function startWidgetConfigWrites(
  stationViewStore: StoreApi<TuiStore>,
  configPath: string,
): () => void {
  let pending: TuiStore["widgets"] | undefined;
  let saving = false;

  // Single-flight writer: `saving` keeps at most one drain running while
  // `pending` coalesces to the newest widget set, so rapid edits (e.g. held
  // reorder keys) collapse into sequential whole-file writes, never interleaved.
  const drain = async (): Promise<void> => {
    if (saving) {
      return;
    }
    saving = true;
    try {
      while (pending !== undefined) {
        const widgets = pending;
        pending = undefined;
        try {
          await setTuiWidgetsInConfig({ configPath, widgets });
        } catch (error) {
          const safeError = safeErrorFromUnknown(error, {
            tag: "StationWidgetConfigError",
            code: "STATION_WIDGET_CONFIG_SAVE_FAILED",
            message: "Could not save widgets to config.toml.",
          });
          stationViewStore.getState().pushToast({
            kind: "error",
            message: "Could not save widgets to config.toml.",
            hint: safeError.message,
          });
        }
      }
    } finally {
      saving = false;
    }
  };

  return stationViewStore.subscribe((state, previous) => {
    if (state.widgets === previous.widgets) {
      return;
    }
    pending = state.widgets;
    void drain();
  });
}

/** Build the input runtime; aux shell placement uses the host when a socket is set. */
function createInputRuntime(
  options: CreateStationOptions,
  deps: {
    store: StationStore;
    stationViewStore: StoreApi<TuiStore>;
    registry: PtyRegistry;
    observerService: StationClient["service"];
    automations: readonly Automation[];
    onShutdown: () => void;
  },
): StationInputRuntime {
  // Aux shells land in the persistent host when a socket is configured; the
  // placement resolver still falls back to local per spawn when the daemon is down.
  const auxShellPlacement =
    options.hostSocketPath === undefined
      ? undefined
      : resolveAuxShellPlacement(options.hostSocketPath);
  const managedTerminalAttacher =
    options.managedTerminalAttacher ??
    (options.hostSocketPath === undefined
      ? undefined
      : createStationHostManagedTerminalAttacher(options.hostSocketPath));
  const inputOptions: Parameters<typeof createStationInputRuntime>[0] = {
    store: deps.store,
    shutdown: deps.onShutdown,
    stationViewStore: deps.stationViewStore,
    registry: deps.registry,
    observerService: deps.observerService,
    autoCloseOverlayOnPaneOpen: options.shellAutoCloseOverlay ?? false,
    automations: deps.automations,
  };
  if (options.openExternalUrl !== undefined) {
    inputOptions.openExternalUrl = options.openExternalUrl;
  }
  if (auxShellPlacement !== undefined) {
    inputOptions.resolveAuxShellPlacement = auxShellPlacement;
  }
  if (managedTerminalAttacher !== undefined) {
    inputOptions.managedTerminalAttacher = managedTerminalAttacher;
  }
  return createStationInputRuntime(inputOptions);
}

/** Assemble the props for <StationApp />, setting optionals only when present. */
function buildViewProps(
  options: CreateStationOptions,
  deps: {
    store: StationStore;
    registry: PtyRegistry;
    stationViewStore: StoreApi<TuiStore>;
    dispatchMouse: StationInputRuntime["dispatchMouse"];
    onCopySelection: (text: string) => void;
    automations: readonly Automation[];
  },
): StationAppProps {
  const viewProps: StationAppProps = {
    store: deps.store,
    registry: deps.registry,
    stationViewStore: deps.stationViewStore,
    dispatchMouse: deps.dispatchMouse,
    onCopySelection: deps.onCopySelection,
    automations: deps.automations,
  };
  if (options.overlayWidthPercent !== undefined) {
    viewProps.overlayWidthPercent = options.overlayWidthPercent;
  }
  if (options.overlayHeightPercent !== undefined) {
    viewProps.overlayHeightPercent = options.overlayHeightPercent;
  }
  const island = options.tuiConfig?.island;
  if (island !== undefined) {
    viewProps.island = island;
  }
  if (options.topRowWidgetDeps !== undefined) {
    viewProps.topRowWidgetDeps = options.topRowWidgetDeps;
  }
  return viewProps;
}

/** A yank handler that fans out to the clipboard sinks and toasts on success. */
function createCopySelectionHandler(
  store: StationStore,
  clipboardEffects: ClipboardEffects,
): (text: string) => void {
  return (text) => {
    if (copyToClipboard(text, DEFAULT_COPY_SINKS, clipboardEffects).copied) {
      store.actions.showToast(copyToastMessage(text));
    }
  };
}
