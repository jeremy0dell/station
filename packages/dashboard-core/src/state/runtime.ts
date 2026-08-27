import type { StationClientStateSource } from "@station/client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../services/errors/errors.js";
import { createNodeFolderService, type TuiFolderService } from "../services/folderService.js";
import type { ObserverService } from "../services/types.js";
import { type DashboardActions, handleTuiAction } from "./actions.js";
import type { DashboardCapabilities } from "./capabilities/execution.js";
import {
  clearDashboardFocus,
  focusDashboardSession,
  reconcileDashboardFocus,
} from "./dashboardFocus.js";
import {
  createTuiLocalOperationRunner,
  type TuiLocalOperationRunner,
} from "./operations/localOperationRunner.js";
import type { DashboardRuntimeEffectScope, DashboardRuntimeTimer } from "./runtimeEffectScope.js";
import { createDashboardRuntimeEffectScope } from "./runtimeEffectScope.js";
import { createInitialTuiState } from "./screen.js";
import { applyAddProjectFolderRefreshed } from "./screens/addProjectScreen.js";
import { applySnapshotSourceState } from "./sourceBridge.js";
import { ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS } from "./timing.js";
import { addTuiToast, expireTuiToasts, refreshActiveTuiToastExpiry } from "./toasts.js";
import { handleTuiKey, type TuiRuntimeContext, type TuiTransition } from "./transition.js";
import type { CreateInitialTuiStateOptions, DashboardState, DashboardStateView } from "./types.js";

/**
 * Type-level readonly state source that preserves Zustand state and notification identity.
 * Values are projected structurally without copying, proxying, or freezing them at runtime.
 */
export type DashboardStateSource = {
  getState(): DashboardStateView;
  getInitialState(): DashboardStateView;
  subscribe(
    listener: (state: DashboardStateView, previous: DashboardStateView) => void,
  ): () => void;
};

/**
 * Required construction boundary for a dashboard-local projection.
 *
 * Every renderer supplies canonical client state, a convergence-safe service, and
 * all four semantic capability groups; dashboard-core never infers native or
 * standalone execution from mutable UI state.
 */
export type DashboardRuntimeOptions = {
  service: ObserverService;
  source: StationClientStateSource;
  capabilities: DashboardCapabilities;
  initialState?: Omit<CreateInitialTuiStateOptions, "initialSnapshot">;
  folderService?: TuiFolderService;
  clientLabel?: string;
  /** Station keymap Help lines prepended to the dashboard Help overlay copy. */
  helpKeymapLineCount?: number;
};

/**
 * Read-only state, closed actions, and repeat-safe lifecycle owned by one dashboard composition.
 *
 * Disposal closes new effect admission synchronously, cancels subscriptions and timers,
 * and resolves only after already-started operations settle without late state writes.
 */
export type DashboardRuntime = {
  state: DashboardStateSource;
  actions: DashboardActions;
  /** Activate source and directory-polling subscriptions at most once. */
  start(): void;
  /** Repeat-safely detach resources and await the one in-flight settlement. */
  dispose(): Promise<void>;
};

/**
 * Create a dashboard-local projection over an external canonical client source.
 *
 * Every pure transition is committed before capability invocation. One private
 * effect scope then owns operation settlement, subscriptions, polling, and expiry
 * timers while injected capabilities receive only semantic request values.
 */
export function createDashboardRuntime(options: DashboardRuntimeOptions): DashboardRuntime {
  const folderService = options.folderService ?? createNodeFolderService();
  const source = options.source;
  const clientLabel = options.clientLabel ?? "TUI";
  const helpKeymapLineCount = options.helpKeymapLineCount;
  const effectScope = createDashboardRuntimeEffectScope();
  let store: StoreApi<DashboardState>;
  const operations = createTuiLocalOperationRunner({
    getStore: () => store,
    service: options.service,
    folderService,
    capabilities: options.capabilities,
    clientLabel,
    scope: effectScope,
  });
  const initialSnapshot = source.getState().snapshot;

  store = createStore<DashboardState>()(() =>
    createInitialTuiState({
      ...(options.initialState ?? {}),
      ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
    }),
  );

  const actions: DashboardActions = {
    handleKey: (key): void => {
      if (!effectScope.isOpen()) return;
      applyTransition(
        store,
        options.service,
        clientLabel,
        operations,
        effectScope,
        handleTuiKey(
          store.getState(),
          key,
          dashboardRuntimeContext(folderService, helpKeymapLineCount),
        ),
      );
    },
    dispatch: (action): void => {
      if (!effectScope.isOpen()) return;
      applyTransition(
        store,
        options.service,
        clientLabel,
        operations,
        effectScope,
        handleTuiAction(
          store.getState(),
          action,
          dashboardRuntimeContext(folderService, helpKeymapLineCount),
        ),
      );
    },
    setTerminalRows: (rows): void => {
      if (!effectScope.isOpen()) return;
      const current = store.getState();
      store.setState(reconcileDashboardFocus(current, { ...current, terminalRows: rows }), true);
    },
    focusDashboardSession: (sessionId): void => {
      if (!effectScope.isOpen()) return;
      store.setState(
        (current) => replaceDashboardFocusState(focusDashboardSession(current, sessionId)),
        true,
      );
    },
    clearDashboardFocus: (): void => {
      if (!effectScope.isOpen()) return;
      store.setState((current) => replaceDashboardFocusState(clearDashboardFocus(current)), true);
    },
    pushToast: (toast): void => {
      if (!effectScope.isOpen()) return;
      store.setState(addTuiToast(store.getState(), toast), true);
    },
    dismissToasts: (): void => {
      if (!effectScope.isOpen()) return;
      store.setState({ toasts: [] });
    },
    expireToasts: (nowMs = Date.now()): void => {
      if (!effectScope.isOpen()) return;
      store.setState(expireTuiToasts(store.getState(), nowMs), true);
    },
    refreshActiveToastExpiry: (nowMs = Date.now()): void => {
      if (!effectScope.isOpen()) return;
      store.setState(refreshActiveTuiToastExpiry(store.getState(), nowMs), true);
    },
  };

  const state: DashboardStateSource = {
    getState: () => store.getState(),
    getInitialState: () => store.getInitialState(),
    subscribe: (listener) => store.subscribe(listener),
  };
  let started = false;
  let disposal: Promise<void> | undefined;
  let stopSnapshotUpdates: (() => void) | undefined;
  let stopDirectoryPolling: (() => void) | undefined;

  return {
    state,
    actions,
    start: (): void => {
      if (started || !effectScope.isOpen()) {
        return;
      }
      started = true;
      stopSnapshotUpdates = attachSnapshotSource(store, source, effectScope);
      stopDirectoryPolling = attachAddProjectDirectoryPolling(store, folderService, effectScope);
    },
    dispose: (): Promise<void> => {
      if (disposal !== undefined) {
        return disposal;
      }
      effectScope.close();
      stopDirectoryPolling?.();
      stopDirectoryPolling = undefined;
      stopSnapshotUpdates?.();
      stopSnapshotUpdates = undefined;
      disposal = effectScope.dispose();
      return disposal;
    },
  };
}

function attachSnapshotSource(
  store: StoreApi<DashboardState>,
  source: StationClientStateSource,
  scope: DashboardRuntimeEffectScope,
): () => void {
  const apply = (): void => {
    scope.commit(() =>
      store.setState(
        applySnapshotSourceState(store.getState(), source.getState(), Date.now()),
        true,
      ),
    );
  };
  apply();
  return source.subscribe(apply);
}

function attachAddProjectDirectoryPolling(
  store: StoreApi<DashboardState>,
  folderService: TuiFolderService,
  scope: DashboardRuntimeEffectScope,
): () => void {
  let activePath: string | undefined;
  let generation = 0;
  let stopped = false;
  let timer: DashboardRuntimeTimer | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      scope.clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (path: string, token: number): void => {
    timer = scope.setTimeout(() => {
      timer = undefined;
      return poll(path, token);
    }, ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
  };

  const poll = async (path: string, token: number): Promise<void> => {
    try {
      const result = await folderService.readDirectory(path);
      // Navigation and teardown invalidate in-flight reads before they can update the chooser.
      if (!stopped && token === generation) {
        scope.commit(() =>
          store.setState(applyAddProjectFolderRefreshed(store.getState(), result)),
        );
      }
    } catch {
      // A transient filesystem failure leaves the current listing intact and retries normally.
    } finally {
      if (
        scope.isOpen() &&
        !stopped &&
        token === generation &&
        activeAddProjectDirectory(store.getState()) === path
      ) {
        schedule(path, token);
      }
    }
  };

  const sync = (): void => {
    const nextPath = activeAddProjectDirectory(store.getState());
    if (nextPath === activePath) {
      return;
    }
    activePath = nextPath;
    generation += 1;
    clearTimer();
    if (nextPath !== undefined) {
      schedule(nextPath, generation);
    }
  };

  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    stopped = true;
    generation += 1;
    clearTimer();
    unsubscribe();
  };
}

function activeAddProjectDirectory(state: DashboardState): string | undefined {
  return state.screen.name === "addProject" && state.screen.flow.mode === "choose"
    ? state.screen.flow.currentPath
    : undefined;
}

function replaceDashboardFocusState(next: DashboardState): DashboardState {
  const replacement: DashboardState = { ...next };
  if (next.dashboardFocus === undefined) {
    delete replacement.dashboardFocus;
  }
  return replacement;
}

function applyTransition(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientLabel: string,
  operations: TuiLocalOperationRunner,
  scope: DashboardRuntimeEffectScope,
  transition: TuiTransition,
): void {
  const replacement: DashboardState = { ...transition.state };
  if (transition.state.persistentFilter === undefined) {
    // Full replacement must delete an absent exact-optional filter instead of materializing undefined.
    delete replacement.persistentFilter;
  }
  // State commits before capability invocation so screen closure and semantic intent are observable first.
  store.setState(replacement, true);
  operations.run(transition.operations);
  scope.run(() => applyTransitionEffects(store, service, clientLabel, transition, scope));
}

async function applyTransitionEffects(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientLabel: string,
  transition: TuiTransition,
  scope: DashboardRuntimeEffectScope,
): Promise<void> {
  if (transition.reconcileReason !== undefined) {
    await reconcileSnapshot(store, service, transition.reconcileReason, clientLabel, scope);
  }
}

async function reconcileSnapshot(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  reason: string,
  clientLabel: string,
  scope: DashboardRuntimeEffectScope,
): Promise<void> {
  try {
    // The client service commits the reconciled snapshot before resolving; the
    // source subscription projects it here before the feedback toast is added.
    await service.reconcile(reason);
    scope.commit(() =>
      store.setState(
        addTuiToast(store.getState(), {
          kind: "success",
          message: "observer.reconcile refreshed",
        }),
      ),
    );
  } catch (error: unknown) {
    scope.commit(() => {
      store.setState(
        addTuiToast(store.getState(), safeErrorToToast(toSafeError(error, { clientLabel }))),
      );
      store.setState({ loading: false });
    });
  }
}

function dashboardRuntimeContext(
  folderService: TuiFolderService,
  helpKeymapLineCount: number | undefined,
): TuiRuntimeContext {
  const context: TuiRuntimeContext = {
    cwd: folderService.cwd(),
    homeDir: folderService.homeDir(),
  };
  if (helpKeymapLineCount !== undefined) {
    context.helpKeymapLineCount = helpKeymapLineCount;
  }
  return context;
}
