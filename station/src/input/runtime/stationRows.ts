import type {
  DashboardSnapshotView,
  DashboardStateSource,
} from "@station/dashboard-core";
import { STATION_HOST_PROVIDER_ID } from "@station/host";
import type { ProviderId } from "@station/contracts";

type DashboardWorktreeRowView = DashboardSnapshotView["rows"][number];

/** How long to wait for a freshly created worktree's row to reach the snapshot. */
const WORKTREE_APPEAR_TIMEOUT_MS = 10_000;

export function findWorktreeRowById(
  store: DashboardStateSource,
  worktreeId: string,
): DashboardWorktreeRowView | undefined {
  return store.getState().snapshot?.rows.find((row) => row.id === worktreeId);
}

export function findWorktreeRowByBranch(
  store: DashboardStateSource,
  projectId: string,
  branch: string,
): DashboardWorktreeRowView | undefined {
  return store
    .getState()
    .snapshot?.rows.find((row) => row.projectId === projectId && row.branch === branch);
}

// The harness a fork inherits: the source's live/recovery harness, else the
// project default — shared by the optimistic row and the launch.
export function inheritedForkHarness(
  store: DashboardStateSource,
  projectId: string,
  sourceWorktreeId: string,
): ProviderId | undefined {
  const snapshot = store.getState().snapshot;
  const source = snapshot?.rows.find((row) => row.id === sourceWorktreeId);
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  return source?.agent?.harness ?? source?.recovery?.provider ?? project?.defaults.harness;
}

/**
 * The external (non-Station) terminal provider holding this worktree, or
 * undefined when it's Station-hosted or unknown — used to tell the user a tmux
 * agent can't be shown in Station rather than focus it to no visible effect.
 */
export function externalTerminalProviderForWorktree(
  store: DashboardStateSource,
  worktreeId: string,
): string | undefined {
  const provider = findWorktreeRowById(store, worktreeId)?.terminal?.provider;
  return provider !== undefined && provider !== STATION_HOST_PROVIDER_ID ? provider : undefined;
}

export function nonFocusableStationTerminalForWorktree(
  store: DashboardStateSource,
  worktreeId: string,
): { label: string } | undefined {
  const row = findWorktreeRowById(store, worktreeId);
  const terminal = row?.terminal;
  if (row === undefined || terminal?.provider !== STATION_HOST_PROVIDER_ID) {
    return undefined;
  }
  return terminal.focusable === true ? undefined : { label: row.branch };
}

/**
 * Resolve a worktree row to its terminal only when detached or stale (running but
 * not attached anywhere Station can render, so a focus is a no-op). An open
 * terminal or a row with no terminal both fall through to the normal launch path.
 */
export function unreachableTerminalRow(
  store: DashboardStateSource,
  worktreeId: string,
): { label: string; provider: string; state: string } | undefined {
  const row = findWorktreeRowById(store, worktreeId);
  const terminal = row?.terminal;
  if (row === undefined || terminal === undefined) {
    return undefined;
  }
  if (terminal.state !== "detached" && terminal.state !== "stale") {
    return undefined;
  }
  return { label: row.branch, provider: terminal.provider, state: terminal.state };
}

export function readinessForWorktree(
  store: DashboardStateSource,
  worktreeId: string,
): { sessionId: string; token: string } | undefined {
  const agent = findWorktreeRowById(store, worktreeId)?.agent;
  if (
    agent?.state !== "idle" ||
    agent.sessionId === undefined ||
    agent.turnReadiness?.state !== "ready_to_read"
  ) {
    return undefined;
  }
  return { sessionId: agent.sessionId, token: agent.turnReadiness.token };
}

/**
 * Resolve once the created worktree's row reaches the snapshot, or undefined on
 * timeout. Subscribes rather than polls so it settles on the first snapshot
 * carrying the row.
 */
export function waitForWorktreeByBranch(
  store: DashboardStateSource,
  projectId: string,
  branch: string,
): Promise<DashboardWorktreeRowView | undefined> {
  const existing = findWorktreeRowByBranch(store, projectId, branch);
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const settle = (row: DashboardWorktreeRowView | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(row);
    };
    const timer = setTimeout(() => settle(undefined), WORKTREE_APPEAR_TIMEOUT_MS);
    const unsubscribe = store.subscribe(() => {
      const row = findWorktreeRowByBranch(store, projectId, branch);
      if (row !== undefined) {
        settle(row);
      }
    });
  });
}
