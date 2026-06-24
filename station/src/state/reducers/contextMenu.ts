import type { ContextMenuAnchor, ContextMenuTarget } from "../../contextMenu/types.js";
import type { FocusTarget, StationState } from "../types.js";
import { fallbackFocus, hasPane, withActivePane } from "./paneFocus.js";

export function focusAfterContextMenu(state: StationState): FocusTarget {
  const topDialog = state.input.dialogStack[state.input.dialogStack.length - 1];
  if (topDialog !== undefined) {
    return { kind: "dialog", dialogId: topDialog };
  }
  if (state.input.activeOverlay !== null) {
    return { kind: "overlay", overlayId: state.input.activeOverlay };
  }
  return fallbackFocus(state);
}

export function closeContextMenuState(state: StationState): StationState {
  if (state.input.contextMenu === null) {
    return state;
  }
  return {
    ...state,
    input: {
      ...state.input,
      contextMenu: null,
      focus: focusAfterContextMenu(state),
    },
  };
}

export function openContextMenuState(
  state: StationState,
  target: ContextMenuTarget,
  anchor: ContextMenuAnchor,
): StationState {
  let next = state;
  if (target.kind === "pane" && hasPane(state.workspace.panes, target.paneId)) {
    next = withActivePane(state, target.paneId);
  }
  return {
    ...next,
    input: {
      ...next.input,
      contextMenu: { target, anchor, activeIndex: 0 },
      focus: { kind: "contextMenu" },
    },
  };
}
