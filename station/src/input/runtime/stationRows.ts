import type { StationClientStateSource } from "@station/client";
import type { ProviderId, SessionView, WorktreeRow } from "@station/contracts";
import { STATION_HOST_PROVIDER_ID } from "@station/host";

const CANONICAL_APPEAR_TIMEOUT_MS = 10_000;

export function findWorktreeRowById(
  store: StationClientStateSource,
  worktreeId: string,
): WorktreeRow | undefined {
  return store.getState().snapshot?.rows.find((row) => row.id === worktreeId);
}

export function findWorktreeRowByBranch(
  store: StationClientStateSource,
  projectId: string,
  branch: string,
): WorktreeRow | undefined {
  return store
    .getState()
    .snapshot?.rows.find((row) => row.projectId === projectId && row.branch === branch);
}

// The harness a fork inherits: the source's live/recovery harness, else the
// project default — shared by the optimistic row and the launch.
export function inheritedForkHarness(
  store: StationClientStateSource,
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
  store: StationClientStateSource,
  worktreeId: string,
): string | undefined {
  const provider = findWorktreeRowById(store, worktreeId)?.terminal?.provider;
  return provider !== undefined && provider !== STATION_HOST_PROVIDER_ID ? provider : undefined;
}

export function nonFocusableStationTerminalForWorktree(
  store: StationClientStateSource,
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
  store: StationClientStateSource,
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
  store: StationClientStateSource,
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
  store: StationClientStateSource,
  projectId: string,
  branch: string,
): Promise<WorktreeRow | undefined> {
  return waitForCanonicalValue(store, () => findWorktreeRowByBranch(store, projectId, branch));
}

/** Wait for the session created on an exact Project branch to reach canonical client state. */
export function waitForSessionByBranch(
  store: StationClientStateSource,
  projectId: string,
  branch: string,
): Promise<SessionView | undefined> {
  return waitForCanonicalValue(store, () => {
    const snapshot = store.getState().snapshot;
    const worktree = snapshot?.rows.find(
      (row) => row.projectId === projectId && row.branch === branch,
    );
    return snapshot?.sessions.find(
      (session) => session.projectId === projectId && session.worktreeId === worktree?.id,
    );
  });
}

function waitForCanonicalValue<T>(
  store: StationClientStateSource,
  find: () => T | undefined,
): Promise<T | undefined> {
  const existing = find();
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const settle = (value: T | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => settle(undefined), CANONICAL_APPEAR_TIMEOUT_MS);
    const unsubscribe = store.subscribe(() => {
      const value = find();
      if (value !== undefined) {
        settle(value);
      }
    });
  });
}
