import type { FocusTarget, InputSlice, PaneId, StationState, WorkspaceSlice } from "../types.js";
import { focusAfterContextMenu } from "./contextMenu.js";
import { fallbackFocus } from "./paneFocus.js";

/**
 * The input slice after a pane removal, shared by closePane (one pane) and
 * closePaneTree (a whole tree). `workspace` is the post-removal panes+active;
 * `isRemoved` reports whether a pane id was part of the removal.
 */
export function inputAfterPaneRemoval(
  state: StationState,
  workspace: WorkspaceSlice,
  isRemoved: (paneId: PaneId) => boolean,
): InputSlice {
  const { focus, overlayReturnFocus, contextMenu } = state.input;

  // Focus on a removed pane retargets to the survivor; focus elsewhere is kept.
  const nextFocus = focus.kind === "pane" && isRemoved(focus.paneId) ? survivingFocus(state, workspace) : focus;
  // Drop an overlay-return pane that's now gone, else closeOverlay would restore it.
  const droppedReturn = overlayReturnFocus?.kind === "pane" && isRemoved(overlayReturnFocus.paneId);

  const next: InputSlice = {
    ...state.input,
    focus: nextFocus,
    overlayReturnFocus: droppedReturn ? null : overlayReturnFocus,
    contextMenu: null,
  };
  // A context menu open over the removal closes; re-seat focus where it would
  // have returned (top dialog / overlay / active pane).
  if (contextMenu === null) {
    return next;
  }
  return { ...next, focus: focusAfterContextMenu({ ...state, workspace, input: next }) };
}

/** The active pane after removal, or the general fallback when none remains. */
function survivingFocus(state: StationState, workspace: WorkspaceSlice): FocusTarget {
  return workspace.activePaneId !== null
    ? { kind: "pane", paneId: workspace.activePaneId }
    : fallbackFocus({ ...state, workspace });
}
