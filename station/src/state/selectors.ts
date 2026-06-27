import {
  STATION_OVERLAY_ID,
  type PaneId,
  type PaneRecord,
  type StationState,
  type StationToast,
} from "./types.js";
import type { ContextMenuAnchor, ContextMenuTarget } from "../contextMenu/types.js";

// Components must select scalars (useSyncExternalStore compares snapshots
// with Object.is); getState() returns the immutable root for everyone else.

export function selectStationOverlayVisible(state: StationState): boolean {
  return state.input.activeOverlay === STATION_OVERLAY_ID;
}

export function selectActivePaneId(state: StationState): PaneId | null {
  return state.workspace.activePaneId;
}

export function selectPaneCount(state: StationState): number {
  return state.workspace.panes.length;
}

// The welcome screen is on screen: the boot intro (over a restored layout) or
// the empty-workspace state, but not while the STATION overlay is up.
export function selectWelcomeVisible(state: StationState): boolean {
  return (
    state.input.activeOverlay === null &&
    (state.input.introVisible || state.workspace.panes.length === 0)
  );
}

// Whether dismissing the intro lands on real sessions (so the welcome offers a
// "Continue" CTA); with no panes there is nothing to continue into.
export function selectWelcomeCanContinue(state: StationState): boolean {
  return state.input.introVisible && state.workspace.panes.length > 0;
}

export function selectPaneRecord(state: StationState, paneId: PaneId): PaneRecord | null {
  return state.workspace.panes.find((pane) => pane.id === paneId) ?? null;
}

export function selectPaneIds(state: StationState): PaneId[] {
  return state.workspace.panes.map((pane) => pane.id);
}

export function selectFocusedPaneId(state: StationState): PaneId | null {
  return state.input.focus.kind === "pane" ? state.input.focus.paneId : null;
}

export function selectContextMenuVisible(state: StationState): boolean {
  return state.input.contextMenu !== null;
}

export function selectContextMenuAnchor(state: StationState): ContextMenuAnchor | null {
  return state.input.contextMenu?.anchor ?? null;
}

export function selectContextMenuTarget(state: StationState): ContextMenuTarget | null {
  return state.input.contextMenu?.target ?? null;
}

export function selectContextMenuActiveIndex(state: StationState): number | null {
  return state.input.contextMenu?.activeIndex ?? null;
}

export function selectToast(state: StationState): StationToast | null {
  return state.feedback.toast;
}
