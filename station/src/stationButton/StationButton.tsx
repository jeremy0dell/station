import { useCallback, useRef, useSyncExternalStore } from "react";
import type { TuiIslandConfig } from "@station/config";
import type { DashboardStateSource } from "@station/dashboard-core";
import type { StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import { isAttentionDismissed } from "../state/attentionDismissal.js";
import { selectPaneRecord, selectStationOverlayVisible } from "../state/selectors.js";
import type { StationStore } from "../state/store.js";
import { agentWorktreePaneId } from "../state/types.js";
import { DynamicStationButton } from "./DynamicStationButton.js";
import {
  attentionKeysFromSnapshot,
  selectStationButtonStatus,
  type StationButtonStatus,
  stationButtonStatusEqual,
} from "./status.js";
import { useMergeCelebration } from "./useMergeCelebration.js";

export type StationButtonProps = {
  /** Coordination store: pane focus + STATION overlay visibility. */
  store: StationStore;
  /** Read-only dashboard state carrying session counts and attention. */
  dashboardState: DashboardStateSource;
  /** Station input runtime entry point, reused for the header toggle/context menu. */
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  /** Opt-in island display modes from `[tui.island]`. */
  island?: TuiIslandConfig | undefined;
};

// Reuses the existing `{ kind: "header" }` mouse path so the route to STATION mode
// survives the header's removal (some terminals never deliver Ctrl-O). Attention
// clicks focus the flagged session instead of toggling, and quiet the alert.
export function StationButton({ store, dashboardState, dispatchMouse, island }: StationButtonProps) {
  const getStatus = useStableStatus(dashboardState, island?.projectRollup === true);
  const subscribe = useCallback(
    (onChange: () => void) => dashboardState.subscribe(onChange),
    [dashboardState],
  );
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  // The dismissal record reference is stable between store actions, so this
  // subscription only re-renders on actual dismiss/re-arm changes.
  const getDismissed = useCallback(
    () => store.getState().feedback.dismissedAttention,
    [store],
  );
  const dismissedAttention = useSyncExternalStore(store.subscribe, getDismissed, getDismissed);
  const celebration = useMergeCelebration(dashboardState);

  // The alert stays up only while some flagged session is not dismissed; a
  // dismissed queue still paints its needs-you count but stops alerting.
  const attention = status.attention && anyFlaggedNotDismissed(dashboardState, dismissedAttention);

  const onHeader = useCallback(
    (event: StationMouseEvent) => {
      dispatchMouse({ kind: "header" }, event);
    },
    [dispatchMouse],
  );

  const onFocusSession = useCallback(
    (event: StationMouseEvent) => {
      // Acting on the alert quiets every session currently asking for the user;
      // a fresh needs_attention transition re-arms.
      store.actions.dismissAttentionKeys(
        attentionKeysFromSnapshot(dashboardState.getState().snapshot),
      );
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
    [dashboardState, dispatchMouse, status.attentionSessionId, status.attentionWorktreeId, store],
  );

  return (
    <DynamicStationButton
      input={{
        status: { ...status, attention },
        restCounts: island?.restCounts,
        celebration,
      }}
      onHoverChange={store.actions.setStationButtonHover}
      onToggleStation={onHeader}
      onContextMenu={onHeader}
      onFocusSession={onFocusSession}
    />
  );
}

/** True when any session asking for the user has not been dismissed. */
function anyFlaggedNotDismissed(
  dashboardState: DashboardStateSource,
  dismissed: Readonly<Record<string, number>>,
): boolean {
  const now = Date.now();
  return attentionKeysFromSnapshot(dashboardState.getState().snapshot).some(
    (key) => !isAttentionDismissed(dismissed, key, now),
  );
}

// Returns the same reference until a field changes, so useSyncExternalStore
// (Object.is-compared) doesn't loop on the fresh object built each call.
function useStableStatus(
  dashboardState: DashboardStateSource,
  projectRollup: boolean,
): () => StationButtonStatus {
  const cache = useRef<StationButtonStatus | undefined>(undefined);
  return useCallback(() => {
    const next = selectStationButtonStatus(dashboardState.getState(), { projectRollup });
    const prev = cache.current;
    if (prev !== undefined && stationButtonStatusEqual(prev, next)) {
      return prev;
    }
    cache.current = next;
    return next;
  }, [dashboardState, projectRollup]);
}
