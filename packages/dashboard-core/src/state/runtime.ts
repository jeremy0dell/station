import { createStationClientRuntime, type StationClientRuntime } from "@station/client";
import type {
  CommandReceipt,
  StationCommand,
  StationSnapshot,
  TerminalFocusOrigin,
  WorktreeRow,
} from "@station/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { sessionForWorktreeRow } from "../selectors/dashboardSessionRows.js";
import { safeErrorToToast, toSafeError } from "../services/errors/errors.js";
import { createNodeFolderService, type TuiFolderService } from "../services/folderService.js";
import type { ClientNotice, ObserverService } from "../services/types.js";
import { type DashboardActionResult, type DashboardActions, handleTuiAction } from "./actions.js";
import { buildFocusCommand } from "./commandBuilders.js";
import {
  clearDashboardFocus,
  focusDashboardSession,
  reconcileDashboardFocus,
} from "./dashboardFocus.js";
import {
  addPendingCreateSessionRow,
  failPendingCreateSessionRow,
  removeCreateSessionLocalRow,
} from "./localRows.js";
import { bridgeOperationService, createObserverBridgeHooks } from "./observerBridge.js";
import {
  createTuiLocalOperationRunner,
  type TuiLocalOperationRunner,
} from "./operations/localOperationRunner.js";
import {
  prepareCommandForRuntime,
  prepareFocusCommandForRuntime,
  type TuiFocusTarget,
} from "./operations/runtimeCommands.js";
import { createInitialTuiState, replaceSnapshot } from "./screen.js";
import { applyAddProjectFolderRefreshed } from "./screens/addProjectScreen.js";
import { submitQuickSession } from "./screens/quickSession.js";
import { applySnapshotSourceState, type TuiSnapshotSource } from "./sourceBridge.js";
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

/** Construction options for a dashboard runtime and its private state store. */
export type DashboardRuntimeOptions = {
  service: ObserverService;
  source?: TuiSnapshotSource;
  initialSnapshot?: StationSnapshot;
  initialState?: Omit<CreateInitialTuiStateOptions, "initialSnapshot" | "runtime">;
  exitOnFocusSuccess?: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<TuiFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  persistentPopup?: boolean;
  onExit?: (code: number) => void;
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
 * Create a dashboard runtime around a private data-only Zustand store.
 *
 * The returned state wrapper deliberately omits `setState`; callers mutate only
 * through {@link DashboardActions}.
 */
export function createDashboardRuntime(options: DashboardRuntimeOptions): DashboardRuntime {
  const runtime = createRuntimeOptions(options);
  const folderService = options.folderService ?? createNodeFolderService();
  const source = options.source;
  let store: StoreApi<DashboardState>;
  let operations: TuiLocalOperationRunner;
  const clientRuntime =
    source === undefined
      ? createStationClientRuntime({
          service: options.service,
          clientLabel: runtime.clientLabel,
          ...(options.initialSnapshot === undefined
            ? {}
            : { initialSnapshot: options.initialSnapshot }),
          hooks: createObserverBridgeHooks({
            getStore: () => store,
            getOperations: () => operations,
          }),
        })
      : undefined;
  operations = createTuiLocalOperationRunner({
    getStore: () => store,
    service:
      clientRuntime === undefined
        ? options.service
        : bridgeOperationService(options.service, clientRuntime),
    folderService,
    runtime,
    clientLabel: runtime.clientLabel,
    focusStartedAgentRow: async (snapshot, row) => {
      await dispatchFocusWithLifecycle(
        store,
        options.service,
        buildStartedAgentFocusCommand(snapshot, row),
        runtime,
      );
    },
  });

  store = createStore<DashboardState>()(() =>
    createInitialTuiState({
      ...(options.initialState ?? {}),
      ...(options.initialSnapshot === undefined
        ? {}
        : { initialSnapshot: options.initialSnapshot }),
      runtime: {
        persistentPopup: runtime.persistentPopup,
        canDismissPopup: runtime.onDismiss !== undefined,
        exitOnFocusSuccess: runtime.exitOnFocusSuccess,
        canResolveFocusOrigin: runtime.resolveFocusTarget !== undefined,
        hasFocusSuccessCallback: runtime.onFocusSuccess !== undefined,
        ...(runtime.focusOrigin === undefined ? {} : { focusOrigin: runtime.focusOrigin }),
      },
    }),
  );

  const actions: DashboardActions = {
    handleKey: (key): DashboardActionResult =>
      applyTransition(
        store,
        options.service,
        clientRuntime,
        runtime,
        operations,
        handleTuiKey(store.getState(), key, {
          cwd: folderService.cwd(),
          homeDir: folderService.homeDir(),
        }),
      ),
    dispatch: (action): DashboardActionResult =>
      applyTransition(
        store,
        options.service,
        clientRuntime,
        runtime,
        operations,
        handleTuiAction(store.getState(), action, {
          cwd: folderService.cwd(),
          homeDir: folderService.homeDir(),
        }),
      ),
    createQuickSession: (projectId): void => {
      applyTransition(
        store,
        options.service,
        clientRuntime,
        runtime,
        operations,
        submitQuickSession(store.getState(), projectId),
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
    addPendingCreateSession: (row): void => {
      store.setState((state) => addPendingCreateSessionRow(state, row), true);
    },
    failPendingCreateSession: (localId, error, expiresAt): void => {
      store.setState(
        (state) => failPendingCreateSessionRow(state, localId, error, expiresAt),
        true,
      );
    },
    removePendingCreateSession: (localId): void => {
      store.setState((state) => removeCreateSessionLocalRow(state, localId), true);
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
      if (source !== undefined) {
        stopSnapshotUpdates = attachSnapshotSource(store, source);
      } else if (clientRuntime === undefined) {
        throw new Error("createDashboardRuntime requires a runtime when no source is provided.");
      } else {
        clientRuntime.start();
        stopSnapshotUpdates = () => {
          void clientRuntime.stop();
        };
      }
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
  source: TuiSnapshotSource,
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

type RuntimeOptions = {
  clientLabel: string;
  exitOnFocusSuccess: boolean;
  persistentPopup: boolean;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<TuiFocusTarget | undefined>;
  onFocusSuccess?: () => Promise<void>;
  onDismiss?: () => Promise<void>;
  onExit?: (code: number) => void;
};

function createRuntimeOptions(options: DashboardRuntimeOptions): RuntimeOptions {
  const runtime: RuntimeOptions = {
    clientLabel: options.clientLabel ?? "TUI",
    exitOnFocusSuccess: options.exitOnFocusSuccess === true,
    persistentPopup: options.persistentPopup === true,
  };
  if (options.focusOrigin !== undefined) {
    runtime.focusOrigin = options.focusOrigin;
  }
  if (options.resolveFocusTarget !== undefined) {
    runtime.resolveFocusTarget = options.resolveFocusTarget;
  }
  if (options.onFocusSuccess !== undefined) {
    runtime.onFocusSuccess = options.onFocusSuccess;
  }
  if (options.onDismiss !== undefined) {
    runtime.onDismiss = options.onDismiss;
  }
  if (options.onExit !== undefined) {
    runtime.onExit = options.onExit;
  }
  return runtime;
}

function applyTransition(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientRuntime: StationClientRuntime | undefined,
  runtime: RuntimeOptions,
  operations: TuiLocalOperationRunner,
  transition: TuiTransition,
): DashboardActionResult {
  const replacement: DashboardState = { ...transition.state };
  if (transition.state.persistentFilter === undefined) {
    // Full replacement must delete an absent exact-optional filter instead of materializing undefined.
    delete replacement.persistentFilter;
  }
  // State lands before effects so one-shot control intents observe the transition they represent.
  store.setState(replacement, true);
  void applyTransitionEffects(store, service, clientRuntime, runtime, operations, transition);
  const result: DashboardActionResult = { dismissPopup: transition.dismissPopup === true };
  if (transition.exitCode !== undefined) {
    result.exitCode = transition.exitCode;
  }
  if (transition.controlIntent !== undefined) {
    result.controlIntent = transition.controlIntent;
  }
  return result;
}

async function applyTransitionEffects(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientRuntime: StationClientRuntime | undefined,
  runtime: RuntimeOptions,
  operations: TuiLocalOperationRunner,
  transition: TuiTransition,
): Promise<void> {
  if (transition.dismissPopup === true && runtime.onDismiss !== undefined) {
    await dismissPersistentPopup(store, runtime.onDismiss, runtime);
  }

  if (transition.exitCode !== undefined) {
    runtime.onExit?.(transition.exitCode);
  }

  if (transition.reconcileReason !== undefined) {
    await reconcileSnapshot(store, service, clientRuntime, transition.reconcileReason, runtime);
  }

  for (const command of transition.commands ?? []) {
    if (shouldUseFocusLifecycle(command, runtime, store.getState().snapshot)) {
      await dispatchFocusWithLifecycle(store, service, command, runtime);
    } else {
      try {
        const prepared = await prepareCommandForRuntime(command, runtime);
        await dispatchCommand(store, service, prepared, runtime);
      } catch (error: unknown) {
        addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
      }
    }
  }

  operations.run(transition.operations);
}

async function reconcileSnapshot(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  clientRuntime: StationClientRuntime | undefined,
  reason: string,
  runtime: Pick<RuntimeOptions, "clientLabel">,
): Promise<void> {
  try {
    if (clientRuntime === undefined) {
      const snapshot = await service.reconcile(reason);
      store.setState(replaceSnapshot(store.getState(), snapshot));
    } else {
      await clientRuntime.reconcile(reason);
      // The reconciled snapshot, connected transition, and recovery toast land
      // through the runtime's refresh hook before reconcile resolves; only the
      // reconcile feedback toast is added here.
    }
    store.setState(
      addTuiToast(store.getState(), {
        kind: "success",
        message: "observer.reconcile refreshed",
      }),
    );
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
    store.setState({ loading: false });
  }
}

async function dispatchCommand(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: StationCommand,
  runtime: Pick<RuntimeOptions, "clientLabel">,
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
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
  }
}

async function dispatchCommandAndWaitForCompletion(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: StationCommand,
  runtime: Pick<RuntimeOptions, "clientLabel">,
): Promise<boolean> {
  try {
    const receipt = await service.dispatch(command);
    const rejectedToast = rejectedCommandToast(command, receipt);
    if (rejectedToast !== undefined) {
      addToast(store, rejectedToast);
      return false;
    }

    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "succeeded") {
      return true;
    }
    addToast(store, safeErrorToToast(completion.error));
    return false;
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
    return false;
  }
}

function shouldUseFocusLifecycle(
  command: StationCommand,
  runtime: Pick<
    RuntimeOptions,
    "exitOnFocusSuccess" | "persistentPopup" | "resolveFocusTarget" | "onFocusSuccess"
  >,
  snapshot: StationSnapshot | undefined,
): command is Extract<StationCommand, { type: "terminal.focus" }> {
  return (
    command.type === "terminal.focus" &&
    (runtime.exitOnFocusSuccess ||
      runtime.persistentPopup ||
      runtime.resolveFocusTarget !== undefined ||
      runtime.onFocusSuccess !== undefined ||
      turnReadinessForFocusCommand(snapshot, command) !== undefined)
  );
}

function buildStartedAgentFocusCommand(
  snapshot: StationSnapshot,
  row: WorktreeRow,
): Extract<StationCommand, { type: "terminal.focus" }> {
  const session = sessionForWorktreeRow(row, snapshot.sessions);
  if (row.agent === undefined && session !== undefined) {
    return {
      type: "terminal.focus",
      payload: {
        sessionId: session.id,
      },
    };
  }
  return buildFocusCommand(row);
}

async function dispatchFocusWithLifecycle(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: Extract<StationCommand, { type: "terminal.focus" }>,
  runtime: RuntimeOptions,
): Promise<void> {
  let focusCommand: Extract<StationCommand, { type: "terminal.focus" }>;
  let focusTarget: TuiFocusTarget | undefined;
  try {
    const prepared = await prepareFocusCommandForRuntime(command, runtime);
    focusCommand = prepared.command;
    focusTarget = prepared.target;
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
    return;
  }

  const turnReadiness = turnReadinessForFocusCommand(store.getState().snapshot, focusCommand);
  const waitsForCompletion =
    runtime.exitOnFocusSuccess ||
    runtime.persistentPopup ||
    runtime.onFocusSuccess !== undefined ||
    focusTarget?.onFocusSuccess !== undefined ||
    turnReadiness !== undefined;
  if (!waitsForCompletion) {
    await dispatchCommand(store, service, focusCommand, runtime);
    return;
  }

  const succeeded = await dispatchCommandAndWaitForCompletion(
    store,
    service,
    focusCommand,
    runtime,
  );
  if (!succeeded) {
    return;
  }

  if (turnReadiness !== undefined) {
    const acknowledged = await dispatchCommandAndWaitForCompletion(
      store,
      service,
      {
        type: "session.acknowledgeTurn",
        payload: turnReadiness,
      },
      runtime,
    );
    if (!acknowledged) {
      return;
    }
  }

  const onFocusSuccess = focusTarget?.onFocusSuccess ?? runtime.onFocusSuccess;
  if (onFocusSuccess !== undefined) {
    try {
      await onFocusSuccess();
    } catch (error: unknown) {
      addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
      return;
    }
  }

  if (runtime.exitOnFocusSuccess && !runtime.persistentPopup) {
    runtime.onExit?.(0);
  }
}

function turnReadinessForFocusCommand(
  snapshot: StationSnapshot | undefined,
  command: Extract<StationCommand, { type: "terminal.focus" }>,
): { sessionId: string; token: string } | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  const row =
    command.payload.sessionId === undefined
      ? snapshot.rows.find((candidate) => candidate.id === command.payload.worktreeId)
      : snapshot.rows.find((candidate) => candidate.agent?.sessionId === command.payload.sessionId);
  const agent = row?.agent;
  if (
    agent?.state !== "idle" ||
    agent.sessionId === undefined ||
    agent.turnReadiness?.state !== "ready_to_read"
  ) {
    return undefined;
  }
  return {
    sessionId: agent.sessionId,
    token: agent.turnReadiness.token,
  };
}

async function dismissPersistentPopup(
  store: StoreApi<DashboardState>,
  onDismiss: () => Promise<void>,
  runtime: Pick<RuntimeOptions, "clientLabel">,
): Promise<void> {
  try {
    await onDismiss();
  } catch (error: unknown) {
    addToast(store, safeErrorToToast(toSafeError(error, { clientLabel: runtime.clientLabel })));
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
