import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { TuiStore } from "@station/dashboard-core";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { selectPaneRecord, selectStationOverlayVisible } from "../state/selectors.js";
import type { StationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { DynamicStationButton } from "./DynamicStationButton.js";
import {
  selectStationButtonStatus,
  type StationButtonStatus,
  stationButtonStatusEqual,
} from "./status.js";

export type StationButtonProps = {
  /** Coordination store: pane focus + STATION overlay visibility. */
  store: StationStore;
  /** The STATION view store the snapshot (session counts/attention) flows into. */
  stationViewStore: StoreApi<TuiStore>;
  /** Station input runtime entry point, reused for the header toggle/context menu. */
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

// Reuses the existing `{ kind: "header" }` mouse path so the route to STATION mode
// survives the header's removal (some terminals never deliver Ctrl-O). Attention
// clicks focus the flagged session instead of toggling.
export function StationButton({ store, stationViewStore, dispatchMouse }: StationButtonProps) {
  const getStatus = useStableStatus(stationViewStore);
  const subscribe = useCallback(
    (onChange: () => void) => stationViewStore.subscribe(onChange),
    [stationViewStore],
  );
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);

  const onHeader = useCallback(
    (event: StationMouseEvent) => {
      dispatchMouse({ kind: "header" }, event);
    },
    [dispatchMouse],
  );

  const onFocusSession = useCallback(
    (event: StationMouseEvent) => {
      const worktreeId = status.attentionWorktreeId;
      // The agent pane id is deterministic from the worktree id; focus it only
      // when that pane actually hosts a primary agent in this workspace.
      const candidate = worktreeId === undefined ? undefined : agentWorktreePaneId(worktreeId);
      const paneId =
        candidate !== undefined &&
        selectPaneRecord(store.getState(), candidate)?.role === "primary-agent"
          ? candidate
          : undefined;
      if (paneId !== undefined) {
        store.actions.focusPane(paneId);
        return;
      }
      // No local pane runs the flagged session — open the dashboard so the user
      // can act on it. Only when the overlay is closed, so we never toggle a
      // visible dashboard shut.
      if (!selectStationOverlayVisible(store.getState())) {
        dispatchMouse({ kind: "header" }, event);
      }
    },
    [dispatchMouse, status.attentionWorktreeId, store],
  );

  return (
    <DynamicStationButton
      attention={status.attention}
      workingCount={status.workingCount}
      idleCount={status.idleCount}
      sessionName={status.sessionName}
      onToggleStation={onHeader}
      onContextMenu={onHeader}
      onFocusSession={onFocusSession}
    />
  );
}

// Returns the same reference until a field changes, so useSyncExternalStore
// (Object.is-compared) doesn't loop on the fresh object built each call.
function useStableStatus(stationViewStore: StoreApi<TuiStore>): () => StationButtonStatus {
  const cache = useRef<StationButtonStatus | undefined>(undefined);
  return useCallback(() => {
    const next = selectStationButtonStatus(stationViewStore.getState());
    const prev = cache.current;
    if (prev !== undefined && stationButtonStatusEqual(prev, next)) {
      return prev;
    }
    cache.current = next;
    return next;
  }, [stationViewStore]);
}
