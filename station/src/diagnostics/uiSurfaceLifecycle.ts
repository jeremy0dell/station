import type { UiLifecycleSurface, UiSurfaceChangeReason } from "@station/contracts";
import type { StationStore } from "../state/store.js";
import type { StationState } from "../state/types.js";
import type { UiLifecycleWitness } from "./uiLifecycle.js";

type UiSurfaceObservation = {
  surface: UiLifecycleSurface;
  activeOverlay: string | null;
  contextMenuOpen: boolean;
  introVisible: boolean;
  hasPanes: boolean;
};

function observeSurface(state: StationState): UiSurfaceObservation {
  const contextMenuOpen = state.input.contextMenu !== null;
  const hasPanes = state.workspace.panes.length > 0;
  let surface: UiLifecycleSurface = "workspace";
  if (contextMenuOpen) {
    surface = "context_menu";
  } else if (state.input.introVisible || state.input.activeOverlay !== null || !hasPanes) {
    surface = "station_overlay";
  }
  return {
    surface,
    activeOverlay: state.input.activeOverlay,
    contextMenuOpen,
    introVisible: state.input.introVisible,
    hasPanes,
  };
}

/** Resolve the stable visible native surface from coordination state. */
export function selectUiLifecycleSurface(state: StationState): UiLifecycleSurface {
  return observeSurface(state).surface;
}

function changeReason(
  before: UiSurfaceObservation,
  after: UiSurfaceObservation,
): UiSurfaceChangeReason {
  if (
    (!before.contextMenuOpen && after.contextMenuOpen) ||
    (before.activeOverlay === null && after.activeOverlay !== null)
  ) {
    return "overlay_open";
  }
  if (
    (before.contextMenuOpen && !after.contextMenuOpen) ||
    (before.activeOverlay !== null && after.activeOverlay === null)
  ) {
    return "overlay_close";
  }
  return "state_change";
}

/** Observe stable end-of-turn surfaces so reducer-only transitions are not reported as painted UI. */
export function observeUiSurfaceLifecycle(input: {
  store: StationStore;
  witness: UiLifecycleWitness;
}): () => void {
  let committed = observeSurface(input.store.getState());
  let pending: UiSurfaceObservation | undefined;
  let scheduled = false;
  let active = true;

  const flush = (): void => {
    scheduled = false;
    if (!active || pending === undefined) {
      return;
    }
    const after = pending;
    pending = undefined;
    const before = committed;
    committed = after;
    if (before.surface === after.surface) {
      return;
    }
    void input.witness.surfaceChanged(
      before.surface,
      after.surface,
      changeReason(before, after),
    );
  };

  const unsubscribe = input.store.subscribe(() => {
    pending = observeSurface(input.store.getState());
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });

  return () => {
    active = false;
    pending = undefined;
    unsubscribe();
  };
}
