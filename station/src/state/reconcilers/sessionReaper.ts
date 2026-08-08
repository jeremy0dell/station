import { paneTreeIds } from "../paneTree.js";
import type { StationStore } from "../store.js";
import type { PaneId } from "../types.js";

export type SessionReaperDeps = {
  store: StationStore;
  /**
   * Live session ids from the observer snapshot, or `undefined` before the
   * first load. A session present here is still alive; one that drops out was
   * removed.
   */
  liveSessionIds: () => ReadonlySet<string> | undefined;
  /**
   * Identity of the observer process now serving state (pid + start time), or
   * `undefined` before the first snapshot. A restarted observer serves an empty
   * snapshot until its startup reconcile repopulates the session graph, so a
   * changed identity re-baselines the seen set rather than reading that window
   * as a mass removal.
   */
  observerInstanceId: () => string | undefined;
  /** Proven-exited panes retain their transcript and tree after graph removal. */
  hasProvenExit: (paneId: PaneId) => boolean;
  /**
   * Terminate a pane's PTY before its record is dropped. dispose() alone only
   * detaches an aux host PTY, leaving it reattachable; a no-op for the
   * already-exited agent pane.
   */
  killPane: (paneId: PaneId) => void;
};

/**
 * Returns a reconcile function the composition subscribes to the observer state
 * source: when a session leaves the snapshot, close its on-screen panes.
 *
 * Owns the set of sessions seen live, re-baselined per observer instance. A
 * managed session reaches the snapshot only after its launch stamps the pane,
 * so a pane whose session has never appeared is mid-launch, not removed. A
 * proven-exited pane retains its transcript even after graph removal; every other
 * session seen live and now gone is reaped. An observer restart re-baselines the
 * set so its empty pre-reconcile snapshot cannot reap every live agent pane.
 */
export function createSessionReaper(deps: SessionReaperDeps): () => void {
  const seenSessionIds = new Set<string>();
  let observerInstance: string | undefined;
  return () => {
    const liveSessionIds = deps.liveSessionIds();
    if (liveSessionIds === undefined) {
      return;
    }
    // A new observer instance starts with an empty session graph and only
    // repopulates after its first reconcile (apps/observer listens on the socket
    // before reconciling). Drop the prior baseline so that empty window cannot
    // be mistaken for a removal of the sessions seen under the old instance.
    const observerInstanceId = deps.observerInstanceId();
    if (observerInstanceId !== observerInstance) {
      observerInstance = observerInstanceId;
      seenSessionIds.clear();
    }
    for (const pane of deps.store.getState().workspace.panes) {
      const sessionId = pane.agentIdentity?.sessionId;
      if (sessionId === undefined) {
        continue;
      }
      if (liveSessionIds.has(sessionId)) {
        seenSessionIds.add(sessionId);
      } else if (seenSessionIds.has(sessionId)) {
        if (deps.hasProvenExit(pane.id)) {
          seenSessionIds.delete(sessionId);
          continue;
        }
        seenSessionIds.delete(sessionId);
        for (const paneId of paneTreeIds(deps.store.getState().workspace.panes, pane.id)) {
          deps.killPane(paneId);
        }
        deps.store.actions.closePaneTree(pane.id);
      }
    }
  };
}
