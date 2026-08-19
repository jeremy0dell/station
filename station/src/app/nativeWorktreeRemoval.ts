import type { ObserverService, StationClientStateSource } from "@station/client";
import { isRunningAgentState, type SafeError } from "@station/contracts";
import {
  finalizeManagedPanesForWorktree,
  prepareManagedPanesForWorktree,
} from "../input/runtime/managedAgentPaneCleanup.js";
import type { StationStore } from "../state/store.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";

const LOCAL_AGENT_EXIT_SETTLE_TIMEOUT_MS = 10_000;
const LOCAL_AGENT_EXIT_RECONCILE_REASON = "station.worktree.remove.local-pane-close";

export type NativeWorktreeRemovalOptions = {
  service: ObserverService;
  clientState: StationClientStateSource;
  store: StationStore;
  registry: PtyRegistry;
  /** Test seam; production waits ten seconds for canonical exit projection. */
  exitSettleTimeoutMs?: number;
};

/** Settle UI-owned PTYs and exact target release under an Observer removal reservation. */
export async function prepareNativeWorktreeRemoval(
  options: NativeWorktreeRemovalOptions,
  worktreeId: string,
): Promise<void> {
  const result = await prepareManagedPanesForWorktree(
    {
      store: options.store,
      registry: options.registry,
      reportExternalExit: (params) => options.service.reportExternalExit(params),
    },
    worktreeId,
  );
  if (!result.externalExitSettled && !externalStationAgentExitIsPending(options.clientState, worktreeId)) {
    return;
  }

  await options.service.reconcile(LOCAL_AGENT_EXIT_RECONCILE_REASON);
  await waitForWorktreeAgentToStop(
    options.clientState,
    worktreeId,
    options.exitSettleTimeoutMs ?? LOCAL_AGENT_EXIT_SETTLE_TIMEOUT_MS,
  );
}

/** Finalize retained transcript/layout records after canonical worktree removal succeeds. */
export function finalizeNativeWorktreeRemoval(
  options: Pick<NativeWorktreeRemovalOptions, "store">,
  worktreeId: string,
): void {
  finalizeManagedPanesForWorktree(options.store, worktreeId);
}

function externalStationAgentExitIsPending(
  source: StationClientStateSource,
  worktreeId: string,
): boolean {
  const snapshot = source.getState().snapshot;
  const row = snapshot?.rows.find((candidate) => candidate.id === worktreeId);
  if (!isRunningAgentState(row?.agent?.state)) return false;
  const stationOwned = snapshot?.sessions.some(
    (session) => session.worktreeId === worktreeId && session.origin === "station",
  );
  if (stationOwned !== true) return false;
  return row?.terminal === undefined || row.terminal.closeable === false;
}

function worktreeAgentIsRunning(source: StationClientStateSource, worktreeId: string): boolean {
  const row = source.getState().snapshot?.rows.find((candidate) => candidate.id === worktreeId);
  return isRunningAgentState(row?.agent?.state);
}

function waitForWorktreeAgentToStop(
  source: StationClientStateSource,
  worktreeId: string,
  timeoutMs: number,
): Promise<void> {
  if (!worktreeAgentIsRunning(source, worktreeId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(exitSettlementTimeout(worktreeId)), timeoutMs);
    const unsubscribe = source.subscribe(() => {
      if (!worktreeAgentIsRunning(source, worktreeId)) settle();
    });
    function settle(error?: SafeError): void {
      clearTimeout(timer);
      unsubscribe();
      error === undefined ? resolve() : reject(error);
    }
  });
}

function exitSettlementTimeout(worktreeId: string): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "TERMINAL_EXIT_NOT_CONFIRMED",
    message: "Station did not confirm that the worktree agent exited.",
    hint: "Keep the worktree and retry after the terminal process has exited.",
    worktreeId,
  };
}
