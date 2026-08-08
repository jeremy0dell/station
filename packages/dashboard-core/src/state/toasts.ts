import type { ClientNotice } from "../services/types.js";
import { toastExpiryMs } from "./timing.js";
import type {
  DashboardScreenView,
  DashboardState,
  DashboardStateView,
  TuiToastEntry,
} from "./types.js";

/** Standard feedback for a semantic dashboard identity absent from canonical state. */
export const STALE_DASHBOARD_TARGET_NOTICE = {
  kind: "info",
  message: "That dashboard item is no longer available.",
} as const satisfies ClientNotice;

export function addTuiToast(
  state: DashboardState,
  toast: ClientNotice,
  nowMs = Date.now(),
): DashboardState {
  const current = expireTuiToasts(state, nowMs);
  const active = activeTuiToast(current);

  if (active !== undefined && toastKey(active.toast) === toastKey(toast)) {
    return {
      ...current,
      toasts: current.toasts.map((entry) =>
        entry.id === active.id ? createToastEntry(entry.id, toast, entry.createdAt, nowMs) : entry,
      ),
    };
  }

  const entry = createToastEntry(toastEntryId(toast, nowMs), toast, nowMs, nowMs);

  return {
    ...current,
    toasts: [...current.toasts, entry].slice(-3),
  };
}

export function addTuiToasts(
  state: DashboardState,
  toasts: readonly ClientNotice[],
  nowMs = Date.now(),
): DashboardState {
  if (toasts.length === 0) {
    return state;
  }
  return toasts.reduce((current, toast) => addTuiToast(current, toast, nowMs), state);
}

export function expireTuiToasts(state: DashboardState, nowMs = Date.now()): DashboardState {
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

export function refreshActiveTuiToastExpiry(
  state: DashboardState,
  nowMs = Date.now(),
): DashboardState {
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

export function activeTuiToast(
  state: Pick<DashboardStateView, "toasts">,
): DashboardStateView["toasts"][number] | undefined {
  return state.toasts.at(-1);
}

export function isTuiToastHiddenByScreen(screen: DashboardScreenView): boolean {
  if (screen.name === "dashboard") {
    return false;
  }
  return screen.name !== "renameSession" || screen.step === "editName";
}

export function nextTuiToastExpiry(state: Pick<DashboardStateView, "toasts">): number | undefined {
  return state.toasts.reduce<number | undefined>((next, entry) => {
    if (entry.expiresAt === undefined) {
      return next;
    }
    return next === undefined ? entry.expiresAt : Math.min(next, entry.expiresAt);
  }, undefined);
}

export function toastKey(toast: ClientNotice): string {
  return JSON.stringify([
    toast.kind,
    toast.message,
    toast.hint ?? null,
    toast.commandId ?? null,
    toast.traceId ?? null,
    toast.diagnosticId ?? null,
  ]);
}

function toastEntryId(toast: ClientNotice, nowMs: number): string {
  return `${nowMs}:${toastKey(toast)}`;
}

function createToastEntry(
  id: string,
  toast: ClientNotice,
  createdAt: number,
  updatedAt: number,
): TuiToastEntry {
  return {
    id,
    toast,
    createdAt,
    updatedAt,
    expiresAt: updatedAt + toastExpiryMs(toast.kind),
  };
}
