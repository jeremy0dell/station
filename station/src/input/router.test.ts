import { describe, expect, it } from "bun:test";
import { createStationStore } from "../state/store.js";
import { MAIN_PANE_ID, STATION_OVERLAY_ID, type StationState } from "../state/types.js";
import type { StationMouseEvent } from "./mouse.js";
import { routeKey, routeMouse, routePaste, type StationCommandId } from "./router.js";
import {
  CLOSE_PANE_LEGACY,
  createStationKeymap,
  createStationMouseBindings,
  FOCUS_NEXT_LEGACY,
  OVERLAY_TOGGLE_LEGACY,
  SPLIT_BELOW_LEGACY,
  SPLIT_RIGHT_LEGACY,
  STATION_EXIT_LEGACY,
} from "./stationBindings.js";

const keymap = createStationKeymap();
const mouseBindings = createStationMouseBindings();
const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 3,
  y: 2,
  modifiers: { shift: false, alt: false, ctrl: false },
};
const RIGHT_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "right",
  rawButton: 2,
  x: 9,
  y: 4,
};
const WHEEL_UP: StationMouseEvent = {
  type: "scroll",
  button: "wheel-up",
  rawButton: 64,
  x: 5,
  y: 3,
  modifiers: { shift: false, alt: false, ctrl: false },
  scrollDirection: "up",
};
const MOVE: StationMouseEvent = {
  ...LEFT_DOWN,
  type: "move",
  button: "unknown",
  rawButton: -1,
};

function paneFocusedState(): StationState {
  return createStationStore().getState();
}

function overlayOpenState(): StationState {
  const store = createStationStore();
  store.actions.openOverlay(STATION_OVERLAY_ID);
  return store.getState();
}

function headerFocusedState(): StationState {
  const store = createStationStore({
    initialWorkspace: {
      panes: [{ id: MAIN_PANE_ID, split: null, role: "shell" }],
      activePaneId: null,
    },
  });
  return store.getState();
}

function welcomeState(): StationState {
  return createStationStore({ boot: "empty" }).getState();
}

describe("routeKey with the station keymap", () => {
  it("writes ordinary and control sequences to the focused pane", () => {
    for (const key of ["a", "\r", "\x03", "\x1b", "\x1b[A"]) {
      expect(routeKey(key, paneFocusedState(), keymap)).toEqual({
        kind: "terminal-write",
        paneId: MAIN_PANE_ID,
        bytes: key,
      });
    }
  });

  it("maps Ctrl-Q to the exit command while a pane is focused", () => {
    expect(routeKey(STATION_EXIT_LEGACY, paneFocusedState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
  });

  it("maps Ctrl-O to overlay-open while a pane is focused", () => {
    expect(routeKey(OVERLAY_TOGGLE_LEGACY, paneFocusedState(), keymap)).toEqual({
      kind: "overlay-open",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("swallows ordinary input while the overlay is open", () => {
    for (const key of ["a", "\r", "\x03"]) {
      expect(routeKey(key, overlayOpenState(), keymap)).toEqual({ kind: "swallowed" });
    }
  });

  it("lets Ctrl-Q pierce the overlay swallow", () => {
    expect(routeKey(STATION_EXIT_LEGACY, overlayOpenState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
  });

  it("maps Ctrl-O to overlay-close while the overlay is open", () => {
    expect(routeKey(OVERLAY_TOGGLE_LEGACY, overlayOpenState(), keymap)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("ignores unbound keys when no passthrough is active", () => {
    expect(routeKey("a", headerFocusedState(), keymap)).toEqual({ kind: "ignored" });
  });

  it("keeps reserved chords available when no passthrough is active", () => {
    expect(routeKey(STATION_EXIT_LEGACY, headerFocusedState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
  });

  it("opens the overlay from welcome with Enter, Space, and Ctrl-O", () => {
    for (const key of ["\r", " ", OVERLAY_TOGGLE_LEGACY]) {
      expect(routeKey(key, welcomeState(), keymap)).toEqual({
        kind: "overlay-open",
        overlayId: STATION_OVERLAY_ID,
      });
    }
  });

  it("swallows ordinary input while on welcome with no pane", () => {
    for (const key of ["a", "\x03", "\x1b[A"]) {
      expect(routeKey(key, welcomeState(), keymap)).toEqual({ kind: "swallowed" });
    }
  });

  it("keeps Ctrl-Q available from welcome", () => {
    expect(routeKey(STATION_EXIT_LEGACY, welcomeState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
  });
});

describe("pane-management chords", () => {
  const CHORDS: ReadonlyArray<readonly [string, StationCommandId]> = [
    [SPLIT_RIGHT_LEGACY, "station.splitRight"],
    [SPLIT_BELOW_LEGACY, "station.splitBelow"],
    [FOCUS_NEXT_LEGACY, "station.focusNextPane"],
    [CLOSE_PANE_LEGACY, "station.closeActivePane"],
  ];

  it("registers all four bytes as reserved keys", () => {
    for (const [byte] of CHORDS) {
      expect(keymap.reservedKeys.has(byte)).toBe(true);
    }
  });

  it("routes to its command while a pane is focused (not terminal-write)", () => {
    for (const [byte, commandId] of CHORDS) {
      expect(routeKey(byte, paneFocusedState(), keymap)).toEqual({ kind: "command", commandId });
    }
  });

  it("pierces the overlay swallow", () => {
    for (const [byte, commandId] of CHORDS) {
      expect(routeKey(byte, overlayOpenState(), keymap)).toEqual({ kind: "command", commandId });
    }
  });
});

describe("routeMouse with the station bindings", () => {
  it("opens the overlay on header click when closed", () => {
    expect(routeMouse({ kind: "header" }, LEFT_DOWN, paneFocusedState(), mouseBindings)).toEqual({
      kind: "overlay-open",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("opens the overlay from the welcome CTA mouse target", () => {
    expect(
      routeMouse({ kind: "welcomeOpenProjectView" }, LEFT_DOWN, welcomeState(), mouseBindings),
    ).toEqual({
      kind: "overlay-open",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("swallows non-primary welcome CTA mouse events", () => {
    expect(
      routeMouse({ kind: "welcomeOpenProjectView" }, RIGHT_DOWN, welcomeState(), mouseBindings),
    ).toEqual({ kind: "swallowed" });
  });

  it("does not make the header a second welcome mouse CTA", () => {
    expect(routeMouse({ kind: "header" }, LEFT_DOWN, welcomeState(), mouseBindings)).toEqual({
      kind: "swallowed",
    });
  });

  it("closes the overlay on header click when open", () => {
    expect(routeMouse({ kind: "header" }, LEFT_DOWN, overlayOpenState(), mouseBindings)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("focuses a pane on click when nothing modal is active", () => {
    expect(
      routeMouse({ kind: "pane", paneId: MAIN_PANE_ID }, LEFT_DOWN, paneFocusedState(), mouseBindings),
    ).toEqual({ kind: "focus", target: { kind: "pane", paneId: MAIN_PANE_ID } });
  });

  it("opens pane context menus on right-click at the event anchor", () => {
    expect(
      routeMouse({ kind: "pane", paneId: MAIN_PANE_ID }, RIGHT_DOWN, paneFocusedState(), mouseBindings),
    ).toEqual({
      kind: "context-menu-open",
      target: { kind: "pane", paneId: MAIN_PANE_ID },
      anchor: { x: 9, y: 4 },
    });
  });

  it("opens header context menus on right-click", () => {
    expect(routeMouse({ kind: "header" }, RIGHT_DOWN, paneFocusedState(), mouseBindings)).toEqual({
      kind: "context-menu-open",
      target: { kind: "header" },
      anchor: { x: 9, y: 4 },
    });
  });

  it("does not focus a pane through the open overlay", () => {
    expect(
      routeMouse({ kind: "pane", paneId: MAIN_PANE_ID }, LEFT_DOWN, overlayOpenState(), mouseBindings),
    ).toEqual({ kind: "swallowed" });
  });

  it("routes a wheel tick over a pane to terminal-scroll", () => {
    expect(
      routeMouse({ kind: "pane", paneId: MAIN_PANE_ID }, WHEEL_UP, paneFocusedState(), mouseBindings),
    ).toEqual({ kind: "terminal-scroll", paneId: MAIN_PANE_ID, direction: "up" });
  });

  it("swallows a pane wheel tick while the overlay is open", () => {
    expect(
      routeMouse({ kind: "pane", paneId: MAIN_PANE_ID }, WHEEL_UP, overlayOpenState(), mouseBindings),
    ).toEqual({ kind: "swallowed" });
  });

  it("closes STATION from a primary click on the STATION backdrop", () => {
    expect(routeMouse({ kind: "stationBackdrop" }, LEFT_DOWN, overlayOpenState(), mouseBindings)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("swallows non-primary STATION backdrop mouse input", () => {
    for (const event of [RIGHT_DOWN, WHEEL_UP, MOVE]) {
      expect(routeMouse({ kind: "stationBackdrop" }, event, overlayOpenState(), mouseBindings)).toEqual({
        kind: "swallowed",
      });
    }
  });

  it("swallows STATION backdrop clicks when STATION is not the active overlay", () => {
    expect(routeMouse({ kind: "stationBackdrop" }, LEFT_DOWN, paneFocusedState(), mouseBindings)).toEqual({
      kind: "swallowed",
    });
  });

  it("routes context menu backdrop and item targets", () => {
    expect(
      routeMouse({ kind: "contextMenuBackdrop" }, LEFT_DOWN, paneFocusedState(), mouseBindings),
    ).toEqual({ kind: "context-menu-close" });
    expect(
      routeMouse({ kind: "contextMenuItem", itemIndex: 2 }, LEFT_DOWN, paneFocusedState(), mouseBindings),
    ).toEqual({ kind: "context-menu-select", itemIndex: 2 });
  });

  it("maps context menu item hover to an absolute highlight, not a select", () => {
    expect(
      routeMouse(
        { kind: "contextMenuItemHover", itemIndex: 1 },
        { ...LEFT_DOWN, type: "move" },
        paneFocusedState(),
        mouseBindings,
      ),
    ).toEqual({ kind: "context-menu-set-active", index: 1 });
  });
});

describe("routePaste", () => {
  it("delivers paste to the focused pane", () => {
    expect(routePaste("hello", paneFocusedState())).toEqual({
      kind: "terminal-paste",
      paneId: MAIN_PANE_ID,
      text: "hello",
    });
  });

  it("ignores paste while the overlay is open", () => {
    expect(routePaste("hello", overlayOpenState())).toEqual({ kind: "ignored" });
  });

  it("ignores paste when focus is not on a pane", () => {
    expect(routePaste("hello", headerFocusedState())).toEqual({ kind: "ignored" });
  });

  it("swallows paste while the context menu is focused", () => {
    const store = createStationStore();
    store.actions.openContextMenu({ kind: "pane", paneId: MAIN_PANE_ID }, { x: 1, y: 1 });
    expect(routePaste("hello", store.getState())).toEqual({ kind: "swallowed" });
  });

  it("swallows paste while on welcome with no pane", () => {
    expect(routePaste("hello", welcomeState())).toEqual({ kind: "swallowed" });
  });
});
