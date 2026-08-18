import type { ObserverService } from "@station/client";
import { paneTreeIds } from "../../state/paneTree.js";
import { selectPaneRecord } from "../../state/selectors.js";
import type { StationStore } from "../../state/store.js";
import { agentWorktreePaneId, type AgentIdentity, type PaneId } from "../../state/types.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";

export type ManagedAgentPaneCleanupDeps = {
  store: StationStore;
  registry: PtyRegistry | undefined;
  reportExternalExit: ObserverService["reportExternalExit"] | undefined;
};

export type LocalManagedAgentPaneTreeCloseResult = {
  paneClosed: boolean;
  localTargetReleased: boolean;
};

/** Close one pane while preserving enough managed identity to release a UI-hosted target. */
export function closePaneWithTerminal(deps: ManagedAgentPaneCleanupDeps, paneId: PaneId): void {
  const release = releaseLocalManagedAgentTarget(deps, paneId);
  deps.registry?.get(paneId)?.terminal?.kill();
  deps.store.actions.closePane(paneId);
  void release.catch(() => undefined);
}

/** Close a local primary-agent tree and wait for Observer to forget its exact binding generation. */
export async function closeLocalManagedAgentPaneTreeForWorktree(
  deps: ManagedAgentPaneCleanupDeps,
  worktreeId: string,
): Promise<LocalManagedAgentPaneTreeCloseResult> {
  const paneId = agentWorktreePaneId(worktreeId);
  const identity = localManagedAgentIdentity(deps.store, paneId);
  if (identity === undefined) {
    return { paneClosed: false, localTargetReleased: false };
  }

  const treePaneIds = paneTreeIds(deps.store.getState().workspace.panes, paneId);
  for (const id of treePaneIds) {
    deps.registry?.get(id)?.terminal?.kill();
  }
  if (treePaneIds.size > 0) {
    deps.store.actions.closePaneTree(paneId);
  }
  const localTargetReleased = await releaseLocalManagedAgentTargetForIdentity(deps, identity);
  return { paneClosed: treePaneIds.size > 0, localTargetReleased };
}

function localManagedAgentIdentity(
  store: StationStore,
  paneId: PaneId,
): AgentIdentity | undefined {
  const identity = selectPaneRecord(store.getState(), paneId)?.agentIdentity;
  return identity?.terminalBindingToken === undefined ? undefined : identity;
}

async function releaseLocalManagedAgentTarget(
  deps: ManagedAgentPaneCleanupDeps,
  paneId: PaneId,
): Promise<boolean> {
  const identity = localManagedAgentIdentity(deps.store, paneId);
  return identity === undefined
    ? false
    : releaseLocalManagedAgentTargetForIdentity(deps, identity);
}

async function releaseLocalManagedAgentTargetForIdentity(
  deps: ManagedAgentPaneCleanupDeps,
  identity: AgentIdentity,
): Promise<boolean> {
  const expectedBindingToken = identity.terminalBindingToken;
  if (deps.reportExternalExit === undefined || expectedBindingToken === undefined) {
    return false;
  }
  const result = await deps.reportExternalExit({
    terminalTargetId: identity.terminalTargetId,
    expectedSessionId: identity.sessionId,
    expectedBindingToken,
  });
  return result.acknowledged;
}
