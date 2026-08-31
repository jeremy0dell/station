import type { Automation } from "../config/stationConfig.js";
import {
  startWidgetConfigWrites,
  type WidgetConfigWrites,
} from "../config/tuiConfig.js";
import {
  type ClipboardEffects,
  copyToClipboard,
  copyToastMessage,
  DEFAULT_COPY_SINKS,
} from "../copy/clipboard.js";
import { createStationInputRuntime, type StationInputRuntime } from "../input/stationInput.js";
import { createManagedLaunch } from "../input/runtime/managedLaunch.js";
import { reportManagedAgentPaneExit } from "../input/runtime/managedAgentPaneCleanup.js";
import { createPaneEffects, type PaneEffects } from "../input/runtime/paneEffects.js";
import {
  invokeCleanup,
  settleCleanupPromises,
  settleCleanupSteps,
} from "../lifecycle/cleanup.js";
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
import { createPtyRegistry, type PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import {
  createStationDashboardRuntime,
  type StationDashboardRuntime,
} from "../station/store/dashboardRuntime.js";
import { createDashboardCapabilities } from "./dashboardCapabilities.js";
import type { CreateStationOptions, Station, StationAppProps } from "./types.js";

/**
 * Wire Station's runtime — dashboard, registry, source reconcilers, layout
 * persistence, lifecycle, and input — and hand back the view props plus a
 * start/dispose surface. Folder navigation and Host placement arrive as
 * capabilities from renderer composition; this module selects neither adapter.
 *
 * Reads as a sequence of steps; each is one extracted helper below.
 */
export function createStation(options: CreateStationOptions): Station {
  const { store, stationClient } = options;
  const automations = options.automations ?? [];

  // Native composition establishes terminal authority before dashboard execution.
  const registry = setupRegistry(options, store, stationClient);
  const paneEffects = createPaneEffects({
    store,
    clientState: stationClient.state,
    registry,
    resolveAuxShellPlacement: options.resolveAuxShellPlacement,
    autoCloseOverlay: options.shellAutoCloseOverlay ?? false,
    automations,
    writeToTerminal: undefined,
    pasteToTerminal: undefined,
    reportExternalExit: (params) => stationClient.service.reportExternalExit(params),
  });
  const managedLaunch = createManagedLaunch({
    store,
    clientState: stationClient.state,
    observerService: stationClient.service,
    registry,
    managedTerminalAttacher: options.managedTerminalAttacher,
  });
  const dashboardCapabilities = createDashboardCapabilities({
    clientState: stationClient.state,
    observerService: stationClient.service,
    store,
    paneEffects,
    registry,
    managedLaunch,
  });
  const dashboardRuntime = createStationDashboardRuntime(
    stationClient,
    dashboardCapabilities,
    {
      folderService: options.folderService,
      ...(options.tuiConfig?.widgets === undefined ? {} : { widgets: options.tuiConfig.widgets }),
      widgetsPersisted: options.tuiConfigPath !== undefined,
    },
  );

  // Source → store/registry bridges, plus debounced disk layout (production only).
  const reconcilers = createReconcilers(store, registry, stationClient);
  const layoutWriter = createLayoutPersistence(options, store, registry);

  // start()/dispose() own the subscription handles opened at start.
  const lifecycle = createLifecycle({
    store,
    stationClient,
    dashboardRuntime,
    registry,
    reconcilers,
    layoutWriter,
    tuiConfigPath: options.tuiConfigPath,
  });
  let shutdownRequested = false;

  // The process owner admits shutdown before starting coordinated composition disposal.
  const stationInput = createInputRuntime(options, {
    store,
    dashboardRuntime,
    registry,
    paneEffects,
    automations,
    onShutdown: () => {
      if (shutdownRequested) {
        return;
      }
      shutdownRequested = true;
      options.shutdown();
    },
  });

  const viewProps = buildViewProps(options, {
    store,
    registry,
    dashboardRuntime,
    dispatchMouse: stationInput.dispatchMouse,
    onCopySelection: createCopySelectionHandler(store, options.clipboardEffects),
    automations,
  });

  return {
    viewProps,
    store,
    registry,
    dashboard: dashboardRuntime,
    stationInput,
    start: lifecycle.start,
    dispose: () => {
      void (async () => {
        try {
          await lifecycle.disposeForShutdown();
        } catch {
          // Legacy synchronous disposal is best-effort; explicit async methods surface settlement.
        }
      })();
    },
    disposeForShutdown: lifecycle.disposeForShutdown,
    disposeForHotReload: lifecycle.disposeForHotReload,
  };
}

// Re-exported so a single import yields both the runtime and its view.
export { StationApp } from "./StationApp.js";
export type { CreateStationOptions, Station } from "./types.js";

type Reconcilers = { reconcile: () => void; reapRemovedSessions: () => void };

/** Create-or-reuse the PTY registry and bind it to this boot's spawn config. */
function setupRegistry(
  options: CreateStationOptions,
  store: StationStore,
  stationClient: StationClient,
): PtyRegistry {
  // Only a UI-owned binding generation may be forgotten from a pane exit.
  // Host-backed liveness remains provider truth and converges through reconcile.
  const reportPaneExit = (paneId: PaneId): void => {
    void reportManagedAgentPaneExit(
      {
        store,
        reportExternalExit: (params) => stationClient.service.reportExternalExit(params),
      },
      paneId,
    ).catch(() => undefined);
  };
  const registry =
    options.registry ??
    createPtyRegistry({
      createTerminal: options.createTerminal,
      onPaneExit: reportPaneExit,
      ...(options.scrollOnOutput === undefined ? {} : { scrollOnOutput: options.scrollOnOutput }),
      ...(options.scrollbackLines === undefined ? {} : { scrollbackLines: options.scrollbackLines }),
    });
  // Refresh a (possibly HMR-reused) registry to this boot's config; createTerminal
  // is left untouched when omitted, so a reused registry keeps its live terminal creator.
  registry.setRuntimeOptions({
    ...(options.createTerminal === undefined ? {} : { createTerminal: options.createTerminal }),
    scrollOnOutput: options.scrollOnOutput,
    scrollbackLines: options.scrollbackLines,
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
    hasProvenExit: (paneId) => registry.get(paneId)?.exited === true,
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
  dashboardRuntime: StationDashboardRuntime;
  registry: PtyRegistry;
  reconcilers: Reconcilers;
  layoutWriter: LayoutWriter | undefined;
  tuiConfigPath: string | undefined;
}): Pick<Station, "start" | "disposeForShutdown" | "disposeForHotReload"> {
  const {
    store,
    stationClient,
    dashboardRuntime,
    registry,
    reconcilers,
    layoutWriter,
    tuiConfigPath,
  } = deps;
  let detachOverlayRowFocus: (() => void) | undefined;
  let detachReconcile: (() => void) | undefined;
  let detachSessionReconcile: (() => void) | undefined;
  let detachLayoutWriter: (() => void) | undefined;
  let widgetConfigWrites: WidgetConfigWrites | undefined;
  let pendingDisposal: Promise<void> | undefined;

  const disposeInternal = (disposeTerminals: boolean): Promise<void> => {
    if (pendingDisposal !== undefined) {
      return pendingDisposal;
    }

    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    pendingDisposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });

    const stopOverlayRowFocus = detachOverlayRowFocus;
    detachOverlayRowFocus = undefined;
    const stopReconcile = detachReconcile;
    detachReconcile = undefined;
    const stopSessionReconcile = detachSessionReconcile;
    detachSessionReconcile = undefined;
    const stopLayoutWriter = detachLayoutWriter;
    detachLayoutWriter = undefined;
    const pendingWidgetWrites = widgetConfigWrites;
    widgetConfigWrites = undefined;

    // The overlay reconciler must detach before dashboard disposal closes its source.
    const overlay = invokeCleanup(() => stopOverlayRowFocus?.());
    const dashboard = invokeCleanup(() => dashboardRuntime.dispose());
    const reconcile = invokeCleanup(() => stopReconcile?.());
    const sessionReconcile = invokeCleanup(() => stopSessionReconcile?.());
    const layoutSubscription = invokeCleanup(() => stopLayoutWriter?.());
    const widgets = invokeCleanup(() => pendingWidgetWrites?.dispose());
    const layout = invokeCleanup(() => {
      // Shutdown flushes synchronously; HMR drops the timer because its runtime is retained.
      if (disposeTerminals) {
        layoutWriter?.flush();
      } else {
        layoutWriter?.dispose();
      }
    });

    // Deliberately keep the registry's pane-exit handler during HMR: an older
    // disposer can run after the replacement installed the current handler.
    const disposeTerminalAndClient = (): Promise<void> =>
      settleCleanupSteps(
        [
          () => {
            // React unmount work scheduled during shutdown cannot own live PTY cleanup.
            if (disposeTerminals) {
              registry.disposeAll();
            }
          },
          // Accepted commands and launch phases settle before their client disappears.
          () => stationClient.stop(),
        ],
        "Native terminal and client cleanup failed.",
      );
    const terminalAndClient = dashboard.then(
      disposeTerminalAndClient,
      disposeTerminalAndClient,
    );
    const settlement = settleCleanupPromises(
      [
        overlay,
        dashboard,
        reconcile,
        sessionReconcile,
        layoutSubscription,
        widgets,
        layout,
        terminalAndClient,
      ],
      "Native Station cleanup failed.",
    );
    settlement.then(resolveDisposal, rejectDisposal);
    return pendingDisposal;
  };

  return {
    start: (): void => {
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
        widgetConfigWrites = startWidgetConfigWrites(
          dashboardRuntime.state,
          dashboardRuntime.actions.pushToast,
          tuiConfigPath,
        );
      }
      dashboardRuntime.start();
      // The overlay bridge may synchronize immediately, so its dashboard source
      // subscription must already be active before the bridge starts.
      detachOverlayRowFocus = createOverlayRowFocusReconciler(store, dashboardRuntime);
      stationClient.start();
    },
    disposeForShutdown: (): Promise<void> => disposeInternal(true),
    disposeForHotReload: (): Promise<void> => disposeInternal(false),
  };
}

/** Build input from composition-supplied terminal capabilities without selecting a Host adapter. */
function createInputRuntime(
  options: CreateStationOptions,
  deps: {
    store: StationStore;
    dashboardRuntime: StationDashboardRuntime;
    registry: PtyRegistry;
    paneEffects: PaneEffects;
    automations: readonly Automation[];
    onShutdown: () => void;
  },
): StationInputRuntime {
  const inputOptions: Parameters<typeof createStationInputRuntime>[0] = {
    store: deps.store,
    shutdown: deps.onShutdown,
    dashboardRuntime: {
      state: deps.dashboardRuntime.state,
      actions: deps.dashboardRuntime.actions,
      clientState: deps.dashboardRuntime.clientState,
      layout: deps.dashboardRuntime.layout,
    },
    registry: deps.registry,
    paneEffects: deps.paneEffects,
    automations: deps.automations,
  };
  if (options.openExternalUrl !== undefined) {
    inputOptions.openExternalUrl = options.openExternalUrl;
  }
  return createStationInputRuntime(inputOptions);
}

/** Assemble the props for <StationApp />, setting optionals only when present. */
function buildViewProps(
  options: CreateStationOptions,
  deps: {
    store: StationStore;
    registry: PtyRegistry;
    dashboardRuntime: StationDashboardRuntime;
    dispatchMouse: StationInputRuntime["dispatchMouse"];
    onCopySelection: (text: string) => void;
    automations: readonly Automation[];
  },
): StationAppProps {
  const viewProps: StationAppProps = {
    store: deps.store,
    registry: deps.registry,
    dashboardState: deps.dashboardRuntime.state,
    clientState: deps.dashboardRuntime.clientState,
    dashboardActions: deps.dashboardRuntime.actions,
    dashboardLayout: deps.dashboardRuntime.layout,
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
