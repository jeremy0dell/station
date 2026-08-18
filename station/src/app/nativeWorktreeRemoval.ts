import type { ObserverService, StationClientStateSource } from "@station/client";
import { isRunningAgentState } from "@station/contracts";
import { STATION_HOST_PROVIDER_ID } from "@station/host";
import { closeLocalManagedAgentPaneTreeForWorktree } from "../input/runtime/managedAgentPaneCleanup.js";
import type { StationStore } from "../state/store.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";

const LOCAL_AGENT_EXIT_SETTLE_TIMEOUT_MS = 10_000;
const LOCAL_AGENT_EXIT_RECONCILE_REASON = "station.worktree.remove.local-pane-close";

export type NativeWorktreeRemovalOptions = {
  service: ObserverService;
  clientState: StationClientStateSource;
  store: StationStore;
  registry: PtyRegistry;
};

/** Close UI-owned PTY state and settle its exit before Observer removes the worktree. */
export async function prepareNativeWorktreeRemoval(
  options: NativeWorktreeRemovalOptions,
  worktreeId: string,
): Promise<void> {
  const closed = await closeLocalManagedAgentPaneTreeForWorktree(
    {
      store: options.store,
      registry: options.registry,
      reportExternalExit: (params) => options.service.reportExternalExit(params),
    },
    worktreeId,
  );
  if (
    !closed.localTargetReleased &&
    !localStationAgentExitIsPending(options.clientState, worktreeId)
  ) {
    return;
  }

  // Close Pane reports target release asynchronously, so Delete may arrive before that reconcile settles.
  await options.service.reconcile(LOCAL_AGENT_EXIT_RECONCILE_REASON).catch(() => undefined);
  await waitForWorktreeAgentToStop(options.clientState, worktreeId);
}

function localStationAgentExitIsPending(
  source: StationClientStateSource,
  worktreeId: string,
): boolean {
  const snapshot = source.getState().snapshot;
  const row = snapshot?.rows.find((candidate) => candidate.id === worktreeId);
  if (!isRunningAgentState(row?.agent?.state)) {
    return false;
  }
  const stationOwned = snapshot?.sessions.some(
    (session) => session.worktreeId === worktreeId && session.origin === "station",
  );
  if (stationOwned !== true) {
    return false;
  }
  return (
    row?.terminal === undefined ||
    (row.terminal.provider === STATION_HOST_PROVIDER_ID &&
      snapshot?.providerHealth[STATION_HOST_PROVIDER_ID]?.capabilities?.canCloseTarget === false)
  );
}

function worktreeAgentIsRunning(source: StationClientStateSource, worktreeId: string): boolean {
  const row = source.getState().snapshot?.rows.find((candidate) => candidate.id === worktreeId);
  return isRunningAgentState(row?.agent?.state);
}

function waitForWorktreeAgentToStop(
  source: StationClientStateSource,
  worktreeId: string,
): Promise<void> {
  if (!worktreeAgentIsRunning(source, worktreeId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(settle, LOCAL_AGENT_EXIT_SETTLE_TIMEOUT_MS);
    const unsubscribe = source.subscribe(() => {
      if (!worktreeAgentIsRunning(source, worktreeId)) {
        settle();
      }
    });
    function settle(): void {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}
