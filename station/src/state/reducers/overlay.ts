import type { OverlayId, StationState } from "../types.js";
import { fallbackFocus } from "./paneFocus.js";

export function openOverlayState(state: StationState, overlayId: OverlayId): StationState {
  if (state.input.activeOverlay === overlayId) {
    return state;
  }
  return {
    ...state,
    input: {
      ...state.input,
      activeOverlay: overlayId,
      contextMenu: null,
      // Only pane focus is worth restoring; anything else falls back to the
      // active pane when the overlay closes.
      overlayReturnFocus: state.input.focus.kind === "pane" ? state.input.focus : null,
      focus: { kind: "overlay", overlayId },
    },
  };
}

export function closeOverlayState(state: StationState): StationState {
  if (state.input.activeOverlay === null) {
    return state;
  }
  return {
    ...state,
    input: {
      ...state.input,
      activeOverlay: null,
      overlayReturnFocus: null,
      contextMenu: null,
      focus: state.input.overlayReturnFocus ?? fallbackFocus(state),
    },
  };
}
