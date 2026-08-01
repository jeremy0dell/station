import {
  selectDashboardSessionRow,
  type TuiControlIntent,
  type TuiStore,
} from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";

export type DashboardRendererEffects = {
  openShell(target: { cwd: string }): void;
  openUrl(url: string): void;
};

const STALE_TARGET_MESSAGE = "That dashboard item is no longer available.";

/** Consumes a one-shot core control intent at the standalone/tmux renderer boundary. */
export function executeDashboardControlIntent(
  intent: TuiControlIntent,
  store: StoreApi<TuiStore>,
  effects: DashboardRendererEffects,
): void {
  switch (intent.type) {
    case "projectShell.open":
      openProjectShell(store, intent.projectId, effects);
      return;
    case "quickSession.create":
      store.getState().createQuickSession(intent.projectId);
      return;
    default:
      return assertNeverControlIntent(intent);
  }
}

/** Resolves a current dashboard row before delegating its shell effect. */
export function openDashboardRowShell(
  store: StoreApi<TuiStore>,
  rowId: string,
  effects: DashboardRendererEffects,
): void {
  const snapshot = store.getState().snapshot;
  if (snapshot === undefined) {
    return;
  }
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined) {
    showStaleDashboardTargetNotice(store);
    return;
  }
  effects.openShell({ cwd: sessionRow.worktree.path });
}

function openProjectShell(
  store: StoreApi<TuiStore>,
  projectId: string,
  effects: DashboardRendererEffects,
): void {
  const project = store
    .getState()
    .snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    showStaleDashboardTargetNotice(store);
    return;
  }
  effects.openShell({ cwd: project.root });
}

/** Reports an inert renderer target that disappeared before activation. */
export function showStaleDashboardTargetNotice(store: StoreApi<TuiStore>): void {
  store.getState().pushToast({ kind: "info", message: STALE_TARGET_MESSAGE });
}

function assertNeverControlIntent(intent: never): never {
  throw new Error(`Unhandled dashboard control intent: ${JSON.stringify(intent)}`);
}
