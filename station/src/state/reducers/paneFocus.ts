import type { FocusTarget, PaneId, PaneRecord, StationState } from "../types.js";

export function hasPane(panes: readonly PaneRecord[], paneId: PaneId): boolean {
  return panes.some((pane) => pane.id === paneId);
}

/** Focus to land on when nothing more specific is recorded. */
export function fallbackFocus(state: StationState): FocusTarget {
  if (state.workspace.activePaneId !== null) {
    return { kind: "pane", paneId: state.workspace.activePaneId };
  }
  return { kind: "welcome" };
}

/**
 * Activate a pane without stealing focus from an open overlay. Overlay closes
 * then return to this pane; unchanged state keeps the same reference.
 */
export function withActivePane(state: StationState, paneId: PaneId): StationState {
  const workspace =
    state.workspace.activePaneId === paneId
      ? state.workspace
      : { ...state.workspace, activePaneId: paneId };
  if (state.input.activeOverlay !== null) {
    const returnFocus = state.input.overlayReturnFocus;
    const returnMatches = returnFocus?.kind === "pane" && returnFocus.paneId === paneId;
    if (workspace === state.workspace && returnMatches) {
      return state;
    }
    return {
      ...state,
      workspace,
      input: { ...state.input, overlayReturnFocus: { kind: "pane", paneId } },
    };
  }
  const focus = state.input.focus;
  const focusMatches = focus.kind === "pane" && focus.paneId === paneId;
  if (workspace === state.workspace && focusMatches) {
    return state;
  }
  return {
    ...state,
    workspace,
    input: { ...state.input, focus: { kind: "pane", paneId } },
  };
}
