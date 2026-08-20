import type { ContextMenuAnchor, ContextMenuTarget } from "../contextMenu/types.js";
import type { StationMouseEvent } from "./mouse.js";
import type { FocusTarget, OverlayId, PaneId, StationState } from "../state/types.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";
import type { KeymapStack } from "./keymap/keymaps.js";

export type StationCommandId =
  | "station.exit"
  | "station.splitRight"
  | "station.splitBelow"
  | "station.focusNextPane"
  | "station.closeActivePane";

/**
 * Keep the executor vocabulary small; prefer commands/store actions except for
 * identity-carrying launches. `swallowed` consumes input; `ignored` falls through.
 */
export type RouteOutcome =
  | { kind: "command"; commandId: StationCommandId }
  | { kind: "terminal-write"; paneId: PaneId; bytes: string }
  | { kind: "terminal-paste"; paneId: PaneId; text: string }
  /**
   * A wheel tick over a pane. The executor decides at apply time (it has the
   * live screen) whether this scrolls the pane's scrollback or is forwarded to
   * the app as input — the pure router can't see alt-screen/mouse-reporting.
   */
  | { kind: "terminal-scroll"; paneId: PaneId; direction: "up" | "down" }
  | { kind: "focus"; target: FocusTarget }
  /** Dismiss the welcome boot intro into the workspace underneath. */
  | { kind: "welcome-dismiss" }
  | { kind: "overlay-open"; overlayId: OverlayId }
  | { kind: "overlay-close"; overlayId: OverlayId }
  | { kind: "context-menu-open"; target: ContextMenuTarget; anchor: ContextMenuAnchor }
  | { kind: "context-menu-close" }
  | { kind: "context-menu-move"; delta: -1 | 1 }
  /**
   * Set the highlighted item absolutely (mouse hover), distinct from the
   * delta-based keyboard `context-menu-move`. Hover and arrow keys must agree
   * on one highlight, so both land on `setContextMenuActiveIndex`.
   */
  | { kind: "context-menu-set-active"; index: number }
  | { kind: "context-menu-select"; itemIndex?: number }
  | { kind: "context-menu-shortcut"; key: string }
  | { kind: "open-url"; url: string }
  | { kind: "swallowed" }
  | { kind: "ignored" };

export type MouseTargetRef =
  | { kind: "header" }
  | { kind: "welcomeOpenProjectView" }
  | { kind: "welcomeContinue" }
  | { kind: "pane"; paneId: PaneId }
  /**
   * A STATION dashboard surface. The view's renderables own hit-testing and
   * stopPropagation; the normalized mouse event carries button and wheel
   * detail beside the target ref.
   */
  | { kind: "station"; target: StationMouseTarget }
  | { kind: "stationBackdrop" }
  | { kind: "contextMenuBackdrop" }
  | { kind: "contextMenuItem"; itemIndex: number }
  | { kind: "contextMenuItemHover"; itemIndex: number };

/**
 * One handler per mouse target kind, declared next to the key bindings so a
 * new mouse target is a table entry. The switch in routeMouse is mechanical
 * dispatch; TypeScript exhaustiveness forces the table to grow with the
 * target union.
 */
export type MouseBindings = {
  header: (
    target: Extract<MouseTargetRef, { kind: "header" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  welcomeOpenProjectView: (
    target: Extract<MouseTargetRef, { kind: "welcomeOpenProjectView" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  welcomeContinue: (
    target: Extract<MouseTargetRef, { kind: "welcomeContinue" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  pane: (
    target: Extract<MouseTargetRef, { kind: "pane" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  station: (
    target: Extract<MouseTargetRef, { kind: "station" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  stationBackdrop: (
    target: Extract<MouseTargetRef, { kind: "stationBackdrop" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  contextMenuBackdrop: (
    target: Extract<MouseTargetRef, { kind: "contextMenuBackdrop" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  contextMenuItem: (
    target: Extract<MouseTargetRef, { kind: "contextMenuItem" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
  contextMenuItemHover: (
    target: Extract<MouseTargetRef, { kind: "contextMenuItemHover" }>,
    state: StationState,
    event: StationMouseEvent,
  ) => RouteOutcome;
};

export function routeKey(
  key: string,
  state: StationState,
  keymap: KeymapStack<RouteOutcome>,
): RouteOutcome {
  return keymap.resolve(key, state) ?? { kind: "ignored" };
}

export function routeMouse(
  target: MouseTargetRef,
  event: StationMouseEvent,
  state: StationState,
  bindings: MouseBindings,
): RouteOutcome {
  switch (target.kind) {
    case "header":
      return bindings.header(target, state, event);
    case "welcomeOpenProjectView":
      return bindings.welcomeOpenProjectView(target, state, event);
    case "welcomeContinue":
      return bindings.welcomeContinue(target, state, event);
    case "pane":
      return bindings.pane(target, state, event);
    case "station":
      return bindings.station(target, state, event);
    case "stationBackdrop":
      return bindings.stationBackdrop(target, state, event);
    case "contextMenuBackdrop":
      return bindings.contextMenuBackdrop(target, state, event);
    case "contextMenuItem":
      return bindings.contextMenuItem(target, state, event);
    case "contextMenuItemHover":
      return bindings.contextMenuItemHover(target, state, event);
  }
}

/**
 * Paste is a separate dispatch from key sequences (OpenTUI routes paste
 * around the sequence handlers, and only the pane knows its bracketed-paste
 * state). It routes by focus: pane focus delivers, overlays ignore so the
 * event stays un-prevented for OpenTUI's own paste handling.
 */
export function routePaste(text: string, state: StationState): RouteOutcome {
  if (state.input.focus.kind === "contextMenu") {
    return { kind: "swallowed" };
  }
  if (
    state.workspace.panes.length === 0 &&
    state.input.activeOverlay === null &&
    state.input.focus.kind === "welcome"
  ) {
    return { kind: "swallowed" };
  }
  if (state.input.activeOverlay !== null) {
    return { kind: "ignored" };
  }
  const focus = state.input.focus;
  if (focus.kind !== "pane") {
    return { kind: "ignored" };
  }
  return { kind: "terminal-paste", paneId: focus.paneId, text };
}
