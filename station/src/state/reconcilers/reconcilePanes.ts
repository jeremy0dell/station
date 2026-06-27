import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { PaneRecord } from "../types.js";
import type { StationStore } from "../store.js";

/**
 * Keep the registry's live PTY entries in step with `workspace.panes`: ensure a
 * registry entry for every pane record and dispose entries whose pane is gone.
 * Runs synchronously on store dispatch (not in React's commit phase) so
 * create/close stay deterministic even when unmount work can't flush before exit.
 */
export function createPaneReconciler(store: StationStore, registry: PtyRegistry): () => void {
  // The store keeps the same `panes` array reference across focus/overlay
  // changes (only create/close allocate a new one), so gating on identity keeps
  // this off the hot input path.
  let lastPanes: readonly PaneRecord[] | undefined;
  return () => {
    const panes = store.getState().workspace.panes;
    if (panes === lastPanes) {
      return;
    }
    lastPanes = panes;
    const paneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of paneIds) {
      registry.ensure(paneId);
    }
    for (const entry of registry.entries()) {
      if (!paneIds.has(entry.paneId)) {
        registry.dispose(entry.paneId);
      }
    }
  };
}
