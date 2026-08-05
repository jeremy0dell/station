import type { StationClientStateSource } from "@station/client";
import type { CommandReceipt, StationCommand } from "@station/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../services/errors/errors.js";
import { createNodeFolderService, type TuiFolderService } from "../services/folderService.js";
import type { ClientNotice, ObserverService } from "../services/types.js";
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
import { createInitialTuiState } from "./screen.js";
import { applyAddProjectFolderRefreshed } from "./screens/addProjectScreen.js";
import { applySnapshotSourceState } from "./sourceBridge.js";
import { ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS } from "./timing.js";
import { addTuiToast, expireTuiToasts, refreshActiveTuiToastExpiry } from "./toasts.js";
import { handleTuiKey, type TuiTransition } from "./transition.js";
import type {
  CreateInitialTuiStateOptions,
  DashboardState,
  DashboardStateView,
  TuiState,
} from "./types.js";

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
};

/** Read-only state, closed actions, and lifecycle owned by one dashboard composition. */
export type DashboardRuntime = {
  state: DashboardStateSource;
  actions: DashboardActions;
  /** Activate source and directory-polling subscriptions at most once. */
  start(): void;
  /** Repeat-safely detach source and directory-polling resources. */
  dispose(): void;
};

/**
 * Create a dashboard-local projection over an external canonical client source.
 *
 * Every pure transition is committed before capability invocation. The runtime then
 * owns optimistic rows, notices, failures, and expiry timers while injected
 * capabilities receive only semantic request values.
 */
export function createDashboardRuntime(options: DashboardRuntimeOptions): DashboardRuntime {
  const folderService = options.folderService ?? createNodeFolderService();
  const source = options.source;
  const clientLabel = options.clientLabel ?? "TUI";
  let store: StoreApi<DashboardState>;
  const operations = createTuiLocalOperationRunner({
    getStore: () => store,
    service: options.service,
    folderService,
    capabilities: options.capabilities,
    clientLabel,
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
      applyTransition(
        store,
        options.service,
        clientLabel,
        operations,
        handleTuiKey(store.getState(), key, {
          cwd: folderService.cwd(),
          homeDir: folderService.homeDir(),
        }),
      );
    },
    dispatch: (action): void => {
      applyTransition(
        store,
        options.service,
        clientLabel,
        operations,
        handleTuiAction(store.getState(), action, {
          cwd: folderService.cwd(),
          homeDir: folderService.homeDir(),
        }),
      );
    },
    setTerminalRows: (rows): void => {
      const current = store.getState();
      store.setState(reconcileDashboardFocus(current, { ...current, terminalRows: rows }), true);
    },
    focusDashboardSession: (sessionId): void => {
      store.setState(
        (current) => replaceDashboardFocusState(focusDashboardSession(current, sessionId)),
        true,
      );
    },
    clearDashboardFocus: (): void => {
      store.setState((current) => replaceDashboardFocusState(clearDashboardFocus(current)), true);
    },
    pushToast: (toast): void => {
      store.setState(addTuiToast(store.getState(), toast), true);
    },
    dismissToasts: (): void => {
      store.setState({ toasts: [] });
    },
    expireToasts: (nowMs = Date.now()): void => {
      store.setState(expireTuiToasts(store.getState(), nowMs), true);
    },
    refreshActiveToastExpiry: (nowMs = Date.now()): void => {
      store.setState(refreshActiveTuiToastExpiry(store.getState(), nowMs), true);
    },
  };

  const state: DashboardStateSource = {
    getState: () => store.getState(),
    getInitialState: () => store.getInitialState(),
    subscribe: (listener) => store.subscribe(listener),
  };
  let started = false;
  let disposed = false;
  let stopSnapshotUpdates: (() => void) | undefined;
  let stopDirectoryPolling: (() => void) | undefined;

  return {
    state,
    actions,
    start: (): void => {
      if (started || disposed) {
        return;
      }
      started = true;
      stopSnapshotUpdates = attachSnapshotSource(store, source);
      stopDirectoryPolling = attachAddProjectDirectoryPolling(store, folderService);
    },
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      stopDirectoryPolling?.();
      stopDirectoryPolling = undefined;
      stopSnapshotUpdates?.();
      stopSnapshotUpdates = undefined;
    },
  };
}

function attachSnapshotSource(
  store: StoreApi<DashboardState>,
  source: StationClientStateSource,
): () => void {
  const apply = (): void => {
    store.setState(applySnapshotSourceState(store.getState(), source.getState(), Date.now()), true);
  };
  apply();
  return source.subscribe(apply);
}

function attachAddProjectDirectoryPolling(
  store: StoreApi<DashboardState>,
  folderService: TuiFolderService,
): () => void {
  let activePath: string | undefined;
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (path: string, token: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void poll(path, token);
    }, ADD_PROJECT_DIRECTORY_POLL_INTERVAL_MS);
  };

  const poll = async (path: string, token: number): Promise<void> => {
    try {
      const result = await folderService.readDirectory(path);
      // Navigation and teardown invalidate in-flight reads before they can update the chooser.
      if (!stopped && token === generation) {
        store.setState(applyAddProjectFolderRefreshed(store.getState(), result));
      }
    } catch {
      // A transient filesystem failure leaves the current listing intact and retries normally.
    } finally {
      if (
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

function activeAddProjectDirectory(state: TuiState): string | undefined {
  return state.screen.name === "addProject" && state.screen.flow.mode === "choose"
    ? state.screen.flow.currentPath
    : undefined;
}

function replaceDashboardFocusState(next: TuiState): DashboardState {
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
  void applyTransitionEffects(store, service, clientLabel, transition);
}

async function applyTransitionEffects(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientLabel: string,
  transition: TuiTransition,
): Promise<void> {
  if (transition.reconcileReason !== undefined) {
    await reconcileSnapshot(store, service, transition.reconcileReason, clientLabel);
  }

  for (const command of transition.commands ?? []) {
    await dispatchCommand(store, service, command, clientLabel);
  }
}

async function reconcileSnapshot(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  reason: string,
  clientLabel: string,
): Promise<void> {
  try {
    // The client service commits the reconciled snapshot before resolving; the
    // source subscription projects it here before the feedback toast is added.
    await service.reconcile(reason);
    store.setState(
      addTuiToast(store.getState(), {
        kind: "success",
        message: "observer.reconcile refreshed",
      }),
    );
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel })));
    store.setState({ loading: false });
  }
}

async function dispatchCommand(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: StationCommand,
  clientLabel: string,
): Promise<void> {
  try {
    const receipt = await service.dispatch(command);
    const rejectedToast = rejectedCommandToast(command, receipt);
    if (rejectedToast !== undefined) {
      addToast(store, rejectedToast);
      return;
    }
    addToast(store, queuedCommandToast(command, receipt));
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel })));
  }
}

function rejectedCommandToast(
  command: StationCommand,
  receipt: CommandReceipt,
): ClientNotice | undefined {
  const receiptError = receipt.error;
  if (!receipt.accepted && receiptError !== undefined) {
    return safeErrorToToast(receiptError);
  }
  if (!receipt.accepted) {
    return {
      kind: "error",
      message: `${command.type} was rejected.`,
    };
  }
  return undefined;
}

function queuedCommandToast(command: StationCommand, receipt: CommandReceipt): ClientNotice {
  return {
    kind: "success",
    message: `${command.type} queued`,
    commandId: receipt.commandId,
    ...(receipt.traceId === undefined ? {} : { traceId: receipt.traceId }),
  };
}

function addToast(store: StoreApi<DashboardState>, toast: ClientNotice): void {
  store.setState(addTuiToast(store.getState(), toast));
}
