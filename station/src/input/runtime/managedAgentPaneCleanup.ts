import type { ObserverService } from "@station/client";
import { paneTreeIds } from "../../state/paneTree.js";
import { selectPaneRecord } from "../../state/selectors.js";
import type { StationStore } from "../../state/store.js";
import {
  agentWorktreePaneId,
  type AgentIdentity,
  type PaneId,
  type PaneRecord,
  worktreeIdFromAgentPaneId,
} from "../../state/types.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";

export type ManagedAgentPaneCleanupDeps = {
  store: StationStore;
  registry: PtyRegistry | undefined;
  reportExternalExit: ObserverService["reportExternalExit"] | undefined;
};

export type ManagedPanePreparationResult = {
  externalExitSettled: boolean;
};

/** Close one pane only after any UI-owned PTY and exact managed binding have settled. */
export function closePaneWithTerminal(deps: ManagedAgentPaneCleanupDeps, paneId: PaneId): void {
  const pane = selectPaneRecord(deps.store.getState(), paneId);
  if (pane === null) return;
  const entry = deps.registry?.get(paneId);
  const uiOwnedAgent = uiOwnsAgentProcess(pane.agentIdentity);
  const ownsLiveProcess =
    (pane.role !== "primary-agent" || uiOwnedAgent) &&
    entry?.terminal !== null &&
    entry?.terminal !== undefined &&
    entry.exited === false;
  if (!ownsLiveProcess && !uiOwnedAgent) {
    deps.store.actions.closePane(paneId);
    return;
  }
  void closePaneAfterTerminalSettlement(deps, pane).catch(() => undefined);
}

/** Deduplicate exact-generation exit reporting; tokenless Host exits reconcile through provider truth. */
export function reportManagedAgentPaneExit(
  deps: Pick<ManagedAgentPaneCleanupDeps, "store" | "reportExternalExit">,
  paneId: PaneId,
): Promise<boolean> {
  const pane = selectPaneRecord(deps.store.getState(), paneId);
  const identity = pane?.agentIdentity;
  if (
    pane === null ||
    identity?.terminalBindingToken === undefined ||
    deps.reportExternalExit === undefined
  ) {
    return Promise.resolve(false);
  }
  return reportManagedAgentIdentityExit(deps, pane, identity);
}

/**
 * Settle every UI-owned PTY associated with one worktree while an Observer removal
 * reservation blocks replacement launches. Layout records remain until command success.
 */
export async function prepareManagedPanesForWorktree(
  deps: ManagedAgentPaneCleanupDeps,
  worktreeId: string,
): Promise<ManagedPanePreparationResult> {
  const panes = panesForWorktree(deps.store, worktreeId);
  const agentPane = panes.find((pane) => pane.role === "primary-agent");
  const localIdentity = uiOwnsAgentProcess(agentPane?.agentIdentity)
    ? agentPane?.agentIdentity
    : undefined;
  const pendingReports = [...deps.store.transient.managedExitReports.values()]
    .filter((entry) => entry.worktreeId === worktreeId)
    .map((entry) => entry.promise);

  const terminalSettlements = panes
    .filter(
      (pane) => pane.role !== "primary-agent" || uiOwnsAgentProcess(pane.agentIdentity),
    )
    .map((pane) => deps.registry?.terminate(pane.id));
  await Promise.all(terminalSettlements);

  let externalExitSettled = pendingReports.length > 0;
  if (localIdentity !== undefined && agentPane !== undefined) {
    externalExitSettled = true;
    await reportManagedAgentIdentityExit(deps, agentPane, localIdentity);
  }
  await Promise.all(pendingReports);
  return { externalExitSettled };
}

/** Remove all retained pane records for a canonically removed worktree. */
export function finalizeManagedPanesForWorktree(store: StationStore, worktreeId: string): void {
  const paneIds = panesForWorktree(store, worktreeId).map((pane) => pane.id).reverse();
  for (const paneId of paneIds) {
    store.actions.closePane(paneId);
  }
}

async function closePaneAfterTerminalSettlement(
  deps: ManagedAgentPaneCleanupDeps,
  pane: PaneRecord,
): Promise<void> {
  const uiOwnedAgent = uiOwnsAgentProcess(pane.agentIdentity);
  if (pane.role !== "primary-agent" || uiOwnedAgent) {
    await deps.registry?.terminate(pane.id);
  }
  if (uiOwnedAgent && pane.agentIdentity !== undefined) {
    await reportManagedAgentIdentityExit(deps, pane, pane.agentIdentity);
  }
  deps.store.actions.closePane(pane.id);
}

function uiOwnsAgentProcess(identity: AgentIdentity | undefined): boolean {
  if (identity?.processOwner !== undefined) return identity.processOwner === "ui";
  return identity?.terminalBindingToken !== undefined;
}

function panesForWorktree(store: StationStore, worktreeId: string): PaneRecord[] {
  const panes = store.getState().workspace.panes;
  const owned = panes.filter((pane) => pane.worktreeId === worktreeId);
  if (owned.length > 0) return owned;
  const rootId = agentWorktreePaneId(worktreeId);
  const legacyTree = paneTreeIds(panes, rootId);
  return panes.filter((pane) => legacyTree.has(pane.id));
}

function reportManagedAgentIdentityExit(
  deps: Pick<ManagedAgentPaneCleanupDeps, "store" | "reportExternalExit">,
  pane: PaneRecord,
  identity: AgentIdentity,
): Promise<boolean> {
  const token = identity.terminalBindingToken;
  if (token === undefined || deps.reportExternalExit === undefined) {
    return Promise.resolve(false);
  }
  const key = `${identity.terminalTargetId}\0${identity.sessionId}\0${token}`;
  const existing = deps.store.transient.managedExitReports.get(key);
  if (existing !== undefined) return existing.promise;

  const promise = deps
    .reportExternalExit({
      terminalTargetId: identity.terminalTargetId,
      expectedSessionId: identity.sessionId,
      expectedBindingToken: token,
    })
    .then((result) => result.acknowledged);
  const worktreeId = pane.worktreeId ?? worktreeIdFromAgentPaneId(pane.id);
  deps.store.transient.managedExitReports.set(key, { worktreeId, promise });
  const clear = (): void => {
    if (deps.store.transient.managedExitReports.get(key)?.promise === promise) {
      deps.store.transient.managedExitReports.delete(key);
    }
  };
  void promise.then(clear, clear);
  return promise;
}
