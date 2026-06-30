import type { StoreApi } from "zustand/vanilla";
import { STATION_OVERLAY_ID, type StationState } from "../../state/types.js";
import { createStationOverlayLayer } from "../../station/input/stationOverlayLayer.js";
import { routeStationMouse } from "../../station/input/stationMouse.js";
import type { TuiStore } from "@station/dashboard-core";
import { createKeymapStack, type KeymapLayer, type KeymapStack } from "./keymaps.js";
import {
  paneLaunchManagedOutcome,
  paneLaunchNewSessionOutcome,
  type MouseBindings,
  type RouteOutcome,
} from "../router.js";
import {
  isPrimaryMouseEvent,
  isRightMouseEvent,
  wheelDirection,
  type StationMouseEvent,
} from "../mouse.js";
import { ControlByte } from "../../terminal/protocol/controlBytes.js";
import { ARROW_KEYS } from "../../terminal/protocol/cursorKeys.js";

export const STATION_EXIT_LEGACY = "\x11"; // Ctrl-Q
export const OVERLAY_TOGGLE_LEGACY = "\x0f"; // Ctrl-O
// Pane-management chords. These four control bytes are the only ones safe to
// reserve (not the Tab \x09 / Enter \r / Esc \x1b collision bytes, not the
// readline staples Ctrl-A/E/W/U/K/R), and each has a kitty CSI-u form that
// normalizes back to the legacy byte. Reserving them means a focused shell can
// never receive them — notably SPLIT_RIGHT steals Ctrl-\ (SIGQUIT). Accepted
// tradeoff for keyboard pane control.
export const SPLIT_RIGHT_LEGACY = "\x1c"; // Ctrl-\
export const SPLIT_BELOW_LEGACY = "\x1e"; // Ctrl-^
export const FOCUS_NEXT_LEGACY = "\x1d"; // Ctrl-]
export const CLOSE_PANE_LEGACY = "\x1f"; // Ctrl-_
export const ESC_LEGACY = ControlByte.Esc;
export const ENTER_LEGACY = "\r";
export const SPACE_LEGACY = " ";
export const ARROW_UP_LEGACY = ARROW_KEYS.up.normal;
export const ARROW_DOWN_LEGACY = ARROW_KEYS.down.normal;

function stationOverlayToggleOutcome(state: StationState): RouteOutcome {
  if (state.input.activeOverlay === STATION_OVERLAY_ID) {
    return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
  }
  return { kind: "overlay-open", overlayId: STATION_OVERLAY_ID };
}

/**
 * The pre-dashboard placeholder: everything except reserved chords is
 * swallowed so keystrokes cannot reach the hidden shell pane. Kept for
 * callers without a STATION view store (tests of the bare stack); the real
 * overlay layer comes from src/station/input/stationOverlayLayer.ts.
 */
const placeholderOverlayLayer: KeymapLayer<RouteOutcome> = {
  id: "overlay",
  isActive: (state) => state.input.activeOverlay === STATION_OVERLAY_ID,
  bindings: [],
  catchAll: () => ({ kind: "swallowed" }),
};

/**
 * Terminal passthrough consumes every non-empty normalized sequence that is
 * not reserved - control bytes, CSI arrows, and escape included, not just
 * printable text. Empty sequences (key releases, untranslatable keys) never
 * reach the router; normalization consumes them first.
 */
const terminalLayer: KeymapLayer<RouteOutcome> = {
  id: "terminal",
  isActive: (state) => state.input.focus.kind === "pane",
  bindings: [],
  catchAll: (key, state) => {
    const focus = state.input.focus;
    if (focus.kind !== "pane") {
      return { kind: "ignored" };
    }
    return { kind: "terminal-write", paneId: focus.paneId, bytes: key };
  },
};

const welcomeLayer: KeymapLayer<RouteOutcome> = {
  id: "base",
  // Active for both the empty-workspace welcome and the boot intro over restored
  // panes — both park focus on the welcome layer.
  isActive: (state) =>
    state.input.activeOverlay === null && state.input.focus.kind === "welcome",
  bindings: [
    {
      keys: [ENTER_LEGACY, SPACE_LEGACY],
      action: (state) =>
        state.workspace.panes.length > 0
          ? { kind: "welcome-dismiss" }
          : { kind: "overlay-open", overlayId: STATION_OVERLAY_ID },
    },
    {
      // Esc slips past the intro into the sessions underneath; with none there is
      // nothing to dismiss into, so swallow.
      keys: [ESC_LEGACY],
      action: (state) =>
        state.workspace.panes.length > 0
          ? { kind: "welcome-dismiss" }
          : { kind: "swallowed" },
    },
  ],
  catchAll: () => ({ kind: "swallowed" }),
};

const contextMenuLayer: KeymapLayer<RouteOutcome> = {
  id: "context-menu",
  isActive: (state) => state.input.focus.kind === "contextMenu" && state.input.contextMenu !== null,
  bindings: [
    {
      keys: [ESC_LEGACY, OVERLAY_TOGGLE_LEGACY],
      action: () => ({ kind: "context-menu-close" }),
    },
    {
      keys: [ARROW_UP_LEGACY],
      action: () => ({ kind: "context-menu-move", delta: -1 }),
    },
    {
      keys: [ARROW_DOWN_LEGACY],
      action: () => ({ kind: "context-menu-move", delta: 1 }),
    },
    {
      keys: [ENTER_LEGACY, SPACE_LEGACY],
      action: () => ({ kind: "context-menu-select" }),
    },
  ],
  catchAll: () => ({ kind: "swallowed" }),
};

const workspaceLayer: KeymapLayer<RouteOutcome> = {
  id: "workspace",
  isActive: () => true,
  bindings: [
    {
      keys: [STATION_EXIT_LEGACY],
      reserved: true,
      action: () => ({ kind: "command", commandId: "station.exit" }),
    },
    {
      keys: [OVERLAY_TOGGLE_LEGACY],
      reserved: true,
      action: stationOverlayToggleOutcome,
    },
    // Reserved so they pierce the terminal-passthrough catch-all (a pane is
    // focused most of the time) and the overlay swallow, the same way Ctrl-Q /
    // Ctrl-O do. The commands resolve the active pane at execution time.
    {
      keys: [SPLIT_RIGHT_LEGACY],
      reserved: true,
      action: () => ({ kind: "command", commandId: "station.splitRight" }),
    },
    {
      keys: [SPLIT_BELOW_LEGACY],
      reserved: true,
      action: () => ({ kind: "command", commandId: "station.splitBelow" }),
    },
    {
      keys: [FOCUS_NEXT_LEGACY],
      reserved: true,
      action: () => ({ kind: "command", commandId: "station.focusNextPane" }),
    },
    {
      keys: [CLOSE_PANE_LEGACY],
      reserved: true,
      action: () => ({ kind: "command", commandId: "station.closeActivePane" }),
    },
  ],
};

/** The registration site: adding a Station chord is one binding here. */
export function createStationKeymap(
  stationViewStore?: StoreApi<TuiStore>,
): KeymapStack<RouteOutcome> {
  const overlayLayer =
    stationViewStore === undefined ? placeholderOverlayLayer : createStationOverlayLayer(stationViewStore);
  return createKeymapStack([contextMenuLayer, overlayLayer, terminalLayer, workspaceLayer, welcomeLayer]);
}

/**
 * Header clicks must work while the overlay is open - the mouse path is the
 * documented fallback for terminal setups that never deliver Ctrl-O, so it
 * is not guarded by the overlay itself. Pane clicks do not focus through an
 * active overlay.
 */
export function createStationMouseBindings(stationViewStore?: StoreApi<TuiStore>): MouseBindings {
  const anchorFrom = (event: StationMouseEvent) => ({ x: event.x, y: event.y });
  return {
    header: (_target, state, event) => {
      if (state.workspace.panes.length === 0 && state.input.activeOverlay === null) {
        return { kind: "swallowed" };
      }
      if (isRightMouseEvent(event)) {
        return {
          kind: "context-menu-open",
          target: { kind: "header" },
          anchor: anchorFrom(event),
        };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return stationOverlayToggleOutcome(state);
    },
    welcomeOpenProjectView: (_target, state, event) => {
      if (state.input.activeOverlay !== null) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "overlay-open", overlayId: STATION_OVERLAY_ID };
    },
    welcomeContinue: (_target, state, event) => {
      if (state.input.activeOverlay !== null) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "welcome-dismiss" };
    },
    pane: (target, state, event) => {
      if (state.input.activeOverlay !== null || state.input.introVisible) {
        return { kind: "swallowed" };
      }
      const scroll = wheelDirection(event);
      if (scroll !== null) {
        return { kind: "terminal-scroll", paneId: target.paneId, direction: scroll };
      }
      if (isRightMouseEvent(event)) {
        return {
          kind: "context-menu-open",
          target: { kind: "pane", paneId: target.paneId },
          anchor: anchorFrom(event),
        };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "focus", target: { kind: "pane", paneId: target.paneId } };
    },
    // STATION targets resolve in the view's own pure router; close-overlay intents surface as router
    // outcomes so the coordination store keeps owning overlay visibility. Hit-testing and wheel
    // direction are the renderable's job (carried in the target ref) — the router never reads event payloads.
    station: (target, state, event) => {
      if (state.input.activeOverlay !== STATION_OVERLAY_ID || stationViewStore === undefined) {
        return { kind: "swallowed" };
      }
      if (isRightMouseEvent(event)) {
        return {
          kind: "context-menu-open",
          target: { kind: "station", target: target.target },
          anchor: anchorFrom(event),
        };
      }
      const outcome = routeStationMouse(target.target, event, stationViewStore);
      if (outcome.kind === "close-overlay") {
        return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
      }
      if (outcome.kind === "open-pane") {
        // Explicit assignments keep command/args/worktreeId absent (not set to
        // undefined) on the shell path — exactOptionalPropertyTypes.
        const paneOpen: Extract<RouteOutcome, { kind: "pane-open" }> = {
          kind: "pane-open",
          paneId: outcome.paneId,
          cwd: outcome.cwd,
          role: outcome.role,
        };
        if (outcome.command !== undefined) {
          paneOpen.command = outcome.command;
        }
        if (outcome.args !== undefined) {
          paneOpen.args = outcome.args;
        }
        if (outcome.worktreeId !== undefined) {
          paneOpen.worktreeId = outcome.worktreeId;
        }
        return paneOpen;
      }
      if (outcome.kind === "launch-managed") {
        return paneLaunchManagedOutcome(outcome);
      }
      if (outcome.kind === "launch-new-session") {
        return paneLaunchNewSessionOutcome(outcome);
      }
      if (outcome.kind === "open-url") {
        return { kind: "open-url", url: outcome.url };
      }
      return { kind: "swallowed" };
    },
    stationBackdrop: (_target, state, event) => {
      if (state.input.activeOverlay !== STATION_OVERLAY_ID) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
    },
    contextMenuBackdrop: () => ({ kind: "context-menu-close" }),
    contextMenuItem: (target) => ({ kind: "context-menu-select", itemIndex: target.itemIndex }),
    // Hover only moves the highlight; the click (contextMenuItem) selects. This
    // keeps mouse highlight in lockstep with keyboard arrows on one index.
    contextMenuItemHover: (target) => ({ kind: "context-menu-set-active", index: target.itemIndex }),
  };
}
