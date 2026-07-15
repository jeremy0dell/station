import type { StationClientRuntime, StationClientRuntimeHooks } from "@station/client";
import type { SafeError, StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast } from "../services/errors/errors.js";
import type { TuiObserverService } from "../services/types.js";
import { clampDashboardStateScroll } from "./dashboardScroll.js";
import type { TuiLocalOperationRunner } from "./operations/localOperationRunner.js";
import { replaceSnapshot } from "./screen.js";
import type { TuiStore } from "./store.js";
import { OBSERVER_RECOVERY_TOAST_THRESHOLD_MS } from "./timing.js";
import { addTuiToast, addTuiToasts } from "./toasts.js";
import type { TuiState } from "./types.js";

export function createObserverBridgeHooks(deps: {
  getStore(): StoreApi<TuiStore>;
  getOperations(): TuiLocalOperationRunner;
}): StationClientRuntimeHooks {
  return {
    onEvent: (event, application) => {
      const store = deps.getStore();
      const current = store.getState();
      if (current.observerConnectionStatus.state !== "connected") {
        store.setState(observerConnectedState(current));
      }
      if (application === undefined) {
        return;
      }
      // Runs after the runtime already reduced the event, which is safe for
      // command.failed: the reducer returns the snapshot unchanged for it, so
      // the runner's pending-row reads see the same state as before reduction.
      const handling =
        event.type === "command.failed"
          ? deps.getOperations().prepareCommandFailedEvent(event)
          : undefined;
      store.setState(
        clampDashboardStateScroll(
          addTuiToasts(
            replaceSnapshot(observerConnectedState(current), application.snapshot),
            handling?.suppressReducerToast === true ? [] : application.notices,
          ),
        ),
      );
      handling?.applyLocalEffect();
    },
    onSubscriptionError: (error, info) => {
      const store = deps.getStore();
      if (info.isConnectError) {
        store.setState(observerConnectionFailureState(store.getState(), error, Date.now()));
        return;
      }
      if (!info.alreadyReported) {
        store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
      }
    },
    onRefreshSettled: (outcome) => {
      const store = deps.getStore();
      if (outcome.status === "loaded") {
        store.setState(
          clampDashboardStateScroll(snapshotLoadedState(store.getState(), outcome.snapshot)),
        );
        return;
      }
      if (outcome.status === "connectFailure") {
        store.setState(observerConnectionFailureState(store.getState(), outcome.error, Date.now()));
        return;
      }
      store.setState(addTuiToast(store.getState(), safeErrorToToast(outcome.error)));
      store.setState({ loading: false });
    },
  };
}

// Operation-driven snapshot loads must flow through the runtime so its reducer
// base stays converged with what lands in the store; a snapshot applied around
// the runtime would be silently reverted by the next incremental event.
export function bridgeOperationService(
  service: TuiObserverService,
  clientRuntime: StationClientRuntime,
): TuiObserverService {
  return {
    loadSnapshot: async () => {
      await clientRuntime.refresh("tui.operation");
      return requireSnapshot(clientRuntime);
    },
    subscribeEvents: () => service.subscribeEvents(),
    dispatch: (command) => service.dispatch(command),
    waitForCommandCompletion: (commandId) => service.waitForCommandCompletion(commandId),
    reconcile: async (reason) => {
      await clientRuntime.reconcile(reason);
      return requireSnapshot(clientRuntime);
    },
    getHarnessReadiness: (params) => service.getHarnessReadiness(params),
    // Command-like RPCs: pass straight through (the observer reconciles itself).
    prepareExternalLaunch: (params) => service.prepareExternalLaunch(params),
    reportExternalExit: (params) => service.reportExternalExit(params),
  };
}

function requireSnapshot(clientRuntime: StationClientRuntime): StationSnapshot {
  const snapshot = clientRuntime.getState().snapshot;
  if (snapshot === undefined) {
    throw new Error("Observer refresh resolved without a snapshot.");
  }
  return snapshot;
}

function snapshotLoadedState(state: TuiState, snapshot: StationSnapshot): TuiState {
  const nowMs = Date.now();
  return observerConnectedState(replaceSnapshot(state, snapshot), {
    nowMs,
    recoveryToast: true,
  });
}

function observerConnectedState(
  state: TuiState,
  options: { nowMs?: number; recoveryToast?: boolean } = {},
): TuiState {
  const previous = state.observerConnectionStatus;
  let next: TuiState = {
    ...state,
    observerConnectionStatus: { state: "connected" },
  };
  const nowMs = options.nowMs ?? Date.now();
  if (
    options.recoveryToast === true &&
    previous.state !== "connected" &&
    nowMs - previous.since > OBSERVER_RECOVERY_TOAST_THRESHOLD_MS
  ) {
    next = addTuiToast(
      next,
      {
        kind: "success",
        message: "Observer reconnected.",
      },
      nowMs,
    );
  }
  return next;
}

function observerConnectionFailureState(
  state: TuiState,
  error: SafeError,
  nowMs: number,
): TuiState {
  const statusState = state.snapshot === undefined ? "reconnecting" : "displayOnly";
  const previous = state.observerConnectionStatus;
  const since = previous.state === statusState ? previous.since : nowMs;
  return {
    ...state,
    loading: state.snapshot === undefined ? state.loading : false,
    observerConnectionStatus: {
      state: statusState,
      since,
      lastError: error,
    },
  };
}
