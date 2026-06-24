import type { StationClientConnectionState } from "@station/client";
import type { StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorEquals } from "../services/errors/errors.js";
import { clampDashboardStateScroll } from "./dashboardScroll.js";
import { replaceSnapshot } from "./screen.js";
import type { TuiStore } from "./store.js";
import { OBSERVER_RECOVERY_TOAST_THRESHOLD_MS } from "./timing.js";
import { addTuiToast } from "./toasts.js";
import type { TuiObserverConnectionStatus, TuiState } from "./types.js";

export type TuiSnapshotSourceState = {
  snapshot?: StationSnapshot;
  connection: StationClientConnectionState;
};

export interface TuiSnapshotSource {
  getState(): TuiSnapshotSourceState;
  subscribe(listener: () => void): () => void;
}

export function attachTuiSnapshotSource(
  store: StoreApi<TuiStore>,
  source: TuiSnapshotSource,
): () => void {
  const apply = (): void => {
    store.setState(applySnapshotSourceState(store.getState(), source.getState(), Date.now()));
  };
  apply();
  return source.subscribe(apply);
}

/**
 * Mirrors the runtime-hook path for callers that already own a subscribable
 * snapshot source: fresh snapshots replace and clamp state, while recovery
 * after a long outage emits the same user-facing reconnection toast.
 */
export function applySnapshotSourceState(
  state: TuiState,
  sourceState: TuiSnapshotSourceState,
  nowMs: number,
): TuiState {
  let next = state;
  if (sourceState.snapshot !== undefined && sourceState.snapshot !== state.snapshot) {
    next = clampDashboardStateScroll(replaceSnapshot(next, sourceState.snapshot));
  }
  return applyConnectionState(next, sourceState.connection, nowMs);
}

function applyConnectionState(
  state: TuiState,
  connection: StationClientConnectionState,
  nowMs: number,
): TuiState {
  switch (connection.state) {
    case "idle":
    case "loading":
      return state;
    case "connected":
      return observerConnectedState(state, nowMs);
    case "reconnecting":
    case "displayOnly":
    case "halted": {
      const status: TuiObserverConnectionStatus =
        state.snapshot === undefined
          ? { state: "reconnecting", since: connection.since, lastError: connection.lastError }
          : { state: "displayOnly", since: connection.since, lastError: connection.lastError };
      const loading = state.snapshot === undefined ? state.loading : false;
      // Sources re-notify on every runtime state swap (in-flight flags,
      // snapshot-only changes), re-deriving an identical failure status each
      // time; returning the same reference keeps subscribers from re-rendering.
      if (loading === state.loading && sameFailureStatus(state.observerConnectionStatus, status)) {
        return state;
      }
      return {
        ...state,
        loading,
        observerConnectionStatus: status,
      };
    }
  }
}

function sameFailureStatus(
  previous: TuiObserverConnectionStatus,
  next: Extract<TuiObserverConnectionStatus, { state: "reconnecting" | "displayOnly" }>,
): boolean {
  if (previous.state !== "reconnecting" && previous.state !== "displayOnly") {
    return false;
  }
  // lastError compares by value: a source that re-derives an equal failure may
  // allocate a fresh error object each notify, and those must still coalesce.
  return (
    previous.state === next.state &&
    previous.since === next.since &&
    safeErrorEquals(previous.lastError, next.lastError)
  );
}

function observerConnectedState(state: TuiState, nowMs: number): TuiState {
  const previous = state.observerConnectionStatus;
  if (previous.state === "connected") {
    return state;
  }
  let next: TuiState = {
    ...state,
    observerConnectionStatus: { state: "connected" },
  };
  if (nowMs - previous.since > OBSERVER_RECOVERY_TOAST_THRESHOLD_MS) {
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
