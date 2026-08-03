import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StationClientStateSource } from "@station/client";
import type { TuiIslandConfig } from "@station/config";
import type { DashboardStateSource } from "@station/dashboard-core";
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
import { useMergeCelebration } from "./useMergeCelebration.js";

export type StationButtonProps = {
  /** Coordination store: pane focus + STATION overlay visibility. */
  store: StationStore;
  /** Dashboard-local state used only to decorate canonical rows with optimistic titles. */
  dashboardState: DashboardStateSource;
  /** Canonical snapshot authority for counts, attention, and project rollups. */
  clientState: StationClientStateSource;
  /** Station input runtime entry point, reused for the header toggle/context menu. */
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  /** Opt-in island display modes from `[tui.island]`. */
  island?: TuiIslandConfig | undefined;
};

// Reuses the existing `{ kind: "header" }` mouse path so the route to STATION mode
// survives the header's removal (some terminals never deliver Ctrl-O). Attention
// clicks focus the flagged session instead of toggling.
export function StationButton({
  store,
  dashboardState,
  clientState,
  dispatchMouse,
  island,
}: StationButtonProps) {
  const getStatus = useStableStatus(clientState, dashboardState, island?.projectRollup === true);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribeClient = clientState.subscribe(onChange);
      const unsubscribeDashboard = dashboardState.subscribe(onChange);
      return () => {
        unsubscribeDashboard();
        unsubscribeClient();
      };
    },
    [clientState, dashboardState],
  );
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  const celebration = useMergeCelebration(clientState);

  const onHeader = useCallback(
    (event: StationMouseEvent) => {
      dispatchMouse({ kind: "header" }, event);
    },
    [dispatchMouse],
  );

  const onFocusSession = useCallback(
    (event: StationMouseEvent) => {
      const worktreeId = status.attentionWorktreeId;
      const sessionId = status.attentionSessionId;
      // A worktree can contain multiple canonical sessions, while its local
      // primary-agent pane id is shared; require the exact session identity.
      const candidate = worktreeId === undefined ? undefined : agentWorktreePaneId(worktreeId);
      const candidatePane =
        candidate === undefined ? undefined : selectPaneRecord(store.getState(), candidate);
      const paneId =
        candidatePane?.role === "primary-agent" &&
        sessionId !== undefined &&
        candidatePane.agentIdentity?.sessionId === sessionId
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
    [dispatchMouse, status.attentionSessionId, status.attentionWorktreeId, store],
  );

  return (
    <DynamicStationButton
      input={{ status, restCounts: island?.restCounts, celebration }}
      onHoverChange={store.actions.setStationButtonHover}
      onToggleStation={onHeader}
      onContextMenu={onHeader}
      onFocusSession={onFocusSession}
    />
  );
}

// Returns the same reference until a field changes, so useSyncExternalStore
// (Object.is-compared) doesn't loop on the fresh object built each call.
function useStableStatus(
  clientState: StationClientStateSource,
  dashboardState: DashboardStateSource,
  projectRollup: boolean,
): () => StationButtonStatus {
  const cache = useRef<StationButtonStatus | undefined>(undefined);
  return useCallback(() => {
    const next = selectStationButtonStatus(
      clientState.getState().snapshot,
      dashboardState.getState().localRows,
      { projectRollup },
    );
    const prev = cache.current;
    if (prev !== undefined && stationButtonStatusEqual(prev, next)) {
      return prev;
    }
    cache.current = next;
    return next;
  }, [clientState, dashboardState, projectRollup]);
}
