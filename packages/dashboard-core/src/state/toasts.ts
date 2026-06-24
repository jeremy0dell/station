import type { TuiToast } from "../services/types.js";
import { toastExpiryMs } from "./timing.js";
import type { TuiState, TuiToastEntry } from "./types.js";

export function addTuiToast(state: TuiState, toast: TuiToast, nowMs = Date.now()): TuiState {
  const current = expireTuiToasts(state, nowMs);
  const active = activeTuiToast(current);
  const expiresAt = nowMs + toastExpiryMs(toast.kind);

  if (active !== undefined && toastKey(active.toast) === toastKey(toast)) {
    return {
      ...current,
      toasts: current.toasts.map((entry) =>
        entry.id === active.id
          ? {
              ...entry,
              toast,
              updatedAt: nowMs,
              expiresAt,
            }
          : entry,
      ),
    };
  }

  const entry: TuiToastEntry = {
    id: toastEntryId(toast, nowMs),
    toast,
    createdAt: nowMs,
    updatedAt: nowMs,
    expiresAt,
  };

  return {
    ...current,
    toasts: [...current.toasts, entry].slice(-3),
  };
}

export function addTuiToasts(
  state: TuiState,
  toasts: readonly TuiToast[],
  nowMs = Date.now(),
): TuiState {
  if (toasts.length === 0) {
    return state;
  }
  return toasts.reduce((current, toast) => addTuiToast(current, toast, nowMs), state);
}

export function expireTuiToasts(state: TuiState, nowMs = Date.now()): TuiState {
  const toasts = state.toasts.filter(
    (entry) => entry.expiresAt === undefined || entry.expiresAt > nowMs,
  );
  if (toasts.length === state.toasts.length) {
    return state;
  }
  return {
    ...state,
    toasts,
  };
}

export function refreshActiveTuiToastExpiry(state: TuiState, nowMs = Date.now()): TuiState {
  const active = activeTuiToast(state);
  if (active === undefined || active.expiresAt === undefined) {
    return state;
  }
  const expiresAt = nowMs + toastExpiryMs(active.toast.kind);
  return {
    ...state,
    toasts: state.toasts.map((entry) =>
      entry.id === active.id
        ? {
            ...entry,
            expiresAt,
          }
        : entry,
    ),
  };
}

export function activeTuiToast(state: Pick<TuiState, "toasts">): TuiToastEntry | undefined {
  return state.toasts.at(-1);
}

export function nextTuiToastExpiry(state: Pick<TuiState, "toasts">): number | undefined {
  return state.toasts.reduce<number | undefined>((next, entry) => {
    if (entry.expiresAt === undefined) {
      return next;
    }
    return next === undefined ? entry.expiresAt : Math.min(next, entry.expiresAt);
  }, undefined);
}

export function toastKey(toast: TuiToast): string {
  return JSON.stringify([
    toast.kind,
    toast.message,
    toast.hint ?? null,
    toast.commandId ?? null,
    toast.traceId ?? null,
    toast.diagnosticId ?? null,
  ]);
}

function toastEntryId(toast: TuiToast, nowMs: number): string {
  return `${nowMs}:${toastKey(toast)}`;
}
