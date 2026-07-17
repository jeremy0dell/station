import { createStationClientRuntime, type StationClientRuntime } from "@station/client";
import type {
  CommandReceipt,
  SessionId,
  StationCommand,
  StationSnapshot,
  TerminalFocusOrigin,
  WorktreeRow,
} from "@station/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { sessionForWorktreeRow } from "../selectors/selectors.js";
import { safeErrorToToast, toSafeError } from "../services/errors/errors.js";
import { createNodeFolderService, type TuiFolderService } from "../services/folderService.js";
import type { TuiObserverService, TuiToast } from "../services/types.js";
import { buildFocusCommand } from "./commandBuilders.js";
import {
  clearDashboardFocus as clearDashboardFocusState,
  focusDashboardSession as focusDashboardSessionState,
} from "./dashboardFocus.js";
import { clampDashboardStateScroll } from "./dashboardScroll.js";
import type { TuiKey } from "./keys.js";
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
import { submitQuickSession } from "./screens/quickSession.js";
import { attachTuiSnapshotSource, type TuiSnapshotSource } from "./sourceBridge.js";
import { addTuiToast, expireTuiToasts, refreshActiveTuiToastExpiry } from "./toasts.js";
import { handleTuiKey, type TuiTransition } from "./transition.js";
import type { CreateInitialTuiStateOptions, TuiState } from "./types.js";

export type TuiHandleKeyResult = {
  dismissPopup: boolean;
  exitCode?: number;
};

export type TuiStore = TuiState & {
  start(): () => void;
  handleKey(key: TuiKey): TuiHandleKeyResult;
  /** Create a project session immediately with its configured default harness. */
  createQuickSession(projectId: string): void;
  setTerminalRows(rows: number): void;
  /** Synchronize row focus from a canonical observer session identity. */
  focusDashboardSession(sessionId: SessionId): void;
  /** Remove transient row focus without changing other dashboard state. */
  clearDashboardFocus(): void;
  /** Surface a client-side toast (e.g. an unresolved-harness notice). */
  pushToast(toast: TuiToast): void;
  dismissToasts(): void;
  expireToasts(nowMs?: number): void;
  refreshActiveToastExpiry(nowMs?: number): void;
};

export type TuiStoreOptions = {
  service: TuiObserverService;
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

export function createTuiStore(options: TuiStoreOptions): StoreApi<TuiStore> {
  const runtime = createRuntimeOptions(options);
  const folderService = options.folderService ?? createNodeFolderService();
  const source = options.source;
  let store: StoreApi<TuiStore>;
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

  store = createStore<TuiStore>()((set, get) => ({
    ...createInitialTuiState({
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
    start: (): (() => void) => {
      if (source !== undefined) {
        return attachTuiSnapshotSource(store, source);
      }
      if (clientRuntime === undefined) {
        throw new Error("createTuiStore requires a runtime when no source is provided.");
      }
      clientRuntime.start();
      return () => {
        void clientRuntime.stop();
      };
    },
    handleKey: (key): TuiHandleKeyResult => {
      const transition = handleTuiKey(get(), key, {
        cwd: folderService.cwd(),
        homeDir: folderService.homeDir(),
      });
      set(transition.state);
      void applyTransitionEffects(
        store,
        options.service,
        clientRuntime,
        runtime,
        operations,
        transition,
      );
      const result: TuiHandleKeyResult = { dismissPopup: transition.dismissPopup === true };
      if (transition.exitCode !== undefined) {
        result.exitCode = transition.exitCode;
      }
      return result;
    },
    createQuickSession: (projectId): void => {
      const transition = submitQuickSession(get(), projectId);
      set(transition.state);
      void applyTransitionEffects(
        store,
        options.service,
        clientRuntime,
        runtime,
        operations,
        transition,
      );
    },
    setTerminalRows: (rows): void => {
      set(clampDashboardStateScroll({ ...get(), terminalRows: rows }));
    },
    focusDashboardSession: (sessionId): void => {
      set(
        (current) =>
          applyDashboardFocusState(current, focusDashboardSessionState(current, sessionId)),
        true,
      );
    },
    clearDashboardFocus: (): void => {
      set((current) => applyDashboardFocusState(current, clearDashboardFocusState(current)), true);
    },
    pushToast: (toast): void => {
      set(addTuiToast(get(), toast));
    },
    dismissToasts: (): void => {
      set({ toasts: [] });
    },
    expireToasts: (nowMs = Date.now()): void => {
      set(expireTuiToasts(get(), nowMs));
    },
    refreshActiveToastExpiry: (nowMs = Date.now()): void => {
      set(refreshActiveTuiToastExpiry(get(), nowMs));
    },
  }));

  return store;
}

function applyDashboardFocusState(current: TuiStore, next: TuiState): TuiStore {
  // Full replacement propagates an absent optional cursor; seeding from the
  // concrete store retains its action methods.
  const replacement = { ...current };
  delete replacement.focusedRowId;
  return { ...replacement, ...next };
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

function createRuntimeOptions(options: TuiStoreOptions): RuntimeOptions {
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

async function applyTransitionEffects(
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
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
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
  clientRuntime: StationClientRuntime | undefined,
  reason: string,
  runtime: Pick<RuntimeOptions, "clientLabel">,
): Promise<void> {
  try {
    if (clientRuntime === undefined) {
      const snapshot = await service.reconcile(reason);
      store.setState(clampDashboardStateScroll(replaceSnapshot(store.getState(), snapshot)));
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
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
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
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
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
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
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
  store: StoreApi<TuiStore>,
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
): TuiToast | undefined {
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

function queuedCommandToast(command: StationCommand, receipt: CommandReceipt): TuiToast {
  return {
    kind: "success",
    message: `${command.type} queued`,
    commandId: receipt.commandId,
    ...(receipt.traceId === undefined ? {} : { traceId: receipt.traceId }),
  };
}

function addToast(store: StoreApi<TuiStore>, toast: TuiToast): void {
  store.setState(addTuiToast(store.getState(), toast));
}
