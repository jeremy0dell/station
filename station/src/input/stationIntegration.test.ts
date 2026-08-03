// Layer conformance for the STATION dashboard registration: real normalized
// byte sequences through the real keymap stack and input runtime, against
// the real coordination store. Pins the stack semantics the spike plan
// documents — app-level exit/toggle chords pierce the overlay layer, pane
// management stays disabled, dismiss intents close via the
// coordination store, and terminal passthrough is untouched when the
// overlay is down.
import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import {
  persistentFilterExperience,
  type DashboardSearchExperience,
  type TuiStore,
} from "@station/dashboard-core";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import { createStationStore, type StationStore } from "../state/store.js";
import { MAIN_PANE_ID, STATION_OVERLAY_ID } from "../state/types.js";
import type { StationMouseEvent } from "./mouse.js";
import { routeKey } from "./router.js";
import {
  CLOSE_PANE_LEGACY,
  createStationKeymap,
  FOCUS_NEXT_LEGACY,
  OVERLAY_TOGGLE_LEGACY,
  SPLIT_BELOW_LEGACY,
  SPLIT_RIGHT_LEGACY,
  STATION_EXIT_LEGACY,
} from "./keymap/stationBindings.js";
import { createStationInputRuntime } from "./stationInput.js";

function makeViewStore(
  dashboardSearchExperience?: DashboardSearchExperience,
): StoreApi<TuiStore> {
  return makeStationTestStore({
    ...(dashboardSearchExperience === undefined ? {} : { dashboardSearchExperience }),
  }).store;
}

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 8,
  y: 4,
  modifiers: { shift: false, alt: false, ctrl: false },
};

const RIGHT_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "right",
  rawButton: 2,
};
const WHEEL_UP: StationMouseEvent = {
  type: "scroll",
  button: "wheel-up",
  rawButton: 64,
  x: 8,
  y: 4,
  modifiers: { shift: false, alt: false, ctrl: false },
  scrollDirection: "up",
};

function makeStationStore(
  overlayOpen: boolean,
  options: { boot?: "empty" } = {},
): StationStore {
  const station =
    options.boot === "empty" ? createStationStore({ boot: "empty" }) : createStationStore();
  if (overlayOpen) {
    station.actions.openOverlay(STATION_OVERLAY_ID);
  }
  return station;
}

describe("station overlay layer in the keymap stack", () => {
  it("routes dashboard keys into the view machine and swallows them", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    expect(routeKey("H", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(view.getState().screen).toEqual({ name: "help" });

    // Esc in help mode closes the MODE, not the overlay.
    expect(routeKey("\x1b", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(view.getState().screen).toEqual({ name: "dashboard" });
  });

  it("maps dashboard dismiss intents to overlay-close", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    expect(routeKey("\x1b", station.getState(), keymap)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
    expect(routeKey("Q", station.getState(), keymap)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
  });

  it("lets exit and toggle chords pierce the dashboard layer from any mode", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    routeKey("/", station.getState(), keymap);
    expect(view.getState().screen).toMatchObject({ name: "search" });

    expect(routeKey(OVERLAY_TOGGLE_LEGACY, station.getState(), keymap)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
    expect(routeKey(STATION_EXIT_LEGACY, station.getState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
    // The search mode never saw the chords as text.
    expect(view.getState().screen).toMatchObject({ name: "search", value: "" });
  });

  it("intercepts direct C as the native managed New Session launch", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);
    routeKey("N", station.getState(), keymap);
    routeKey("\x1b[B", station.getState(), keymap);

    expect(routeKey("C", station.getState(), keymap)).toMatchObject({
      kind: "pane-launch-new-session",
      projectId: "station",
      harness: "codex",
    });
  });

  it("swallows native pane commands while the dashboard is open", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    for (const key of [
      SPLIT_RIGHT_LEGACY,
      SPLIT_BELOW_LEGACY,
      FOCUS_NEXT_LEGACY,
      CLOSE_PANE_LEGACY,
    ]) {
      expect(routeKey(key, station.getState(), keymap)).toEqual({ kind: "swallowed" });
    }
  });

  it("swallows unknown escape sequences without polluting text inputs", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    routeKey("/", station.getState(), keymap);
    routeKey("a", station.getState(), keymap);
    expect(routeKey("\x1b[15~", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(view.getState().screen).toMatchObject({ name: "search", value: "a" });
  });

  it("leaves terminal passthrough untouched while the overlay is down", () => {
    const view = makeViewStore();
    const station = makeStationStore(false);
    const keymap = createStationKeymap(view);

    expect(routeKey("H", station.getState(), keymap)).toMatchObject({
      kind: "terminal-write",
      bytes: "H",
    });
    expect(view.getState().screen).toEqual({ name: "dashboard" });
  });
});

describe("station input through the station runtime", () => {
  function makeRuntime(
    overlayOpen: boolean,
    options: {
      boot?: "empty";
      dashboardSearchExperience?: DashboardSearchExperience;
    } = {},
  ) {
    const view = makeViewStore(options.dashboardSearchExperience);
    const station = makeStationStore(overlayOpen, options);
    const written: string[] = [];
    const pasted: string[] = [];
    const runtime = createStationInputRuntime({
      store: station,
      shutdown: () => {},
      stationViewStore: view,
      writeToTerminal: (_paneId, bytes) => {
        written.push(bytes);
        return true;
      },
      pasteToTerminal: (_paneId, text) => {
        pasted.push(text);
        return true;
      },
    });
    return { view, station, runtime, written, pasted };
  }

  it("drives the full keyboard path: sequence -> machine -> coordination store", () => {
    const { view, station, runtime } = makeRuntime(true);

    expect(runtime.handleSequence("/")).toBe(true);
    expect(runtime.handleSequence("p")).toBe(true);
    expect(view.getState().screen).toMatchObject({ name: "search", value: "p" });

    expect(runtime.handleSequence("\x1b")).toBe(true); // cancel search
    expect(runtime.handleSequence("\x1b")).toBe(true); // dismiss overlay
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(station.getState().input.focus.kind).toBe("pane");
  });

  it("drives persistent filter cancel, apply, retained close, and clear through the runtime", () => {
    const { view, station, runtime } = makeRuntime(true, {
      dashboardSearchExperience: persistentFilterExperience,
    });

    expect(runtime.handleSequence("/")).toBe(true);
    expect(runtime.handleSequence("working")).toBe(true);
    expect(view.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "working", cursor: 7 },
    });
    expect(runtime.handleSequence("\x1b")).toBe(true);
    expect(view.getState().screen).toEqual({ name: "dashboard" });
    expect(view.getState().persistentFilter).toBeUndefined();

    runtime.handleSequence("/");
    runtime.handleSequence("working");
    runtime.handleSequence("\r");
    expect(view.getState().persistentFilter).toEqual({ query: "working" });

    expect(runtime.handleSequence("Q")).toBe(true);
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(view.getState().persistentFilter).toEqual({ query: "working" });

    const clearing = makeRuntime(true, {
      dashboardSearchExperience: persistentFilterExperience,
    });
    clearing.runtime.handleSequence("/");
    clearing.runtime.handleSequence("working");
    clearing.runtime.handleSequence("\r");
    expect(
      routeKey(
        "\x1b",
        clearing.station.getState(),
        createStationKeymap(clearing.view),
      ),
    ).toEqual({ kind: "swallowed" });
    expect(clearing.station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
    expect(clearing.view.getState().persistentFilter).toBeUndefined();
    expect(clearing.runtime.handleSequence("\x1b")).toBe(true);
    expect(clearing.station.getState().input.activeOverlay).toBeNull();
  });

  it("sanitizes persistent-filter paste and reserves global chords from the draft", () => {
    const { view, station, runtime } = makeRuntime(true, {
      dashboardSearchExperience: persistentFilterExperience,
    });
    runtime.handleSequence("/");

    runtime.handlePaste({
      bytes: new TextEncoder().encode("sta\x1b[31mtion\x00\nover\rlay\x07"),
      preventDefault: () => {},
    });
    expect(view.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "sta[31mtion over lay" },
    });

    expect(runtime.handleSequence(OVERLAY_TOGGLE_LEGACY)).toBe(true);
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(view.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "sta[31mtion over lay" },
    });
  });

  it("routes Ctrl-U through new-session edit-name without inserting a literal u", () => {
    const { view, runtime } = makeRuntime(true);

    expect(runtime.handleSequence("N")).toBe(true);
    expect(runtime.handleSequence("N")).toBe(true);
    expect(runtime.handleSequence("featurefoo")).toBe(true);
    expect(runtime.handleSequence("\x1b[D")).toBe(true);
    expect(runtime.handleSequence("\x1b[D")).toBe(true);
    expect(runtime.handleSequence("\x1b[D")).toBe(true);
    expect(runtime.handleSequence("\x15")).toBe(true);

    const screen = view.getState().screen;
    if (screen.name !== "newSession" || screen.flow.mode !== "editName") {
      throw new Error("expected new-session edit-name mode");
    }
    expect(screen.flow.draftName).toEqual({ value: "foo", cursor: 0 });
  });

  it("delivers pastes to the dashboard's text inputs while the overlay is up", () => {
    const { view, runtime, pasted } = makeRuntime(true);
    runtime.handleSequence("/");

    let prevented = false;
    runtime.handlePaste({
      bytes: new TextEncoder().encode("station-overlay"),
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(pasted).toEqual([]);
    expect(view.getState().screen).toMatchObject({ name: "search", value: "station-overlay" });
  });

  it("strips control bytes from pastes so they cannot leak into text inputs", () => {
    const { view, runtime } = makeRuntime(true);
    runtime.handleSequence("/");

    runtime.handlePaste({
      bytes: new TextEncoder().encode("sta\x1b[31mtion\x00\nover\rlay\x07"),
      preventDefault: () => {},
    });

    expect(view.getState().screen).toMatchObject({
      name: "search",
      value: "sta[31mtion over lay",
    });
  });

  it("routes view mouse targets through the active overlay", () => {
    const { view, station, runtime } = makeRuntime(true);

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect([...view.getState().collapsedProjectIds]).toEqual(["station"]);
    expect(station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
  });

  it("routes New Session action clicks without leaking input to panes", () => {
    const { view, station, runtime, written } = makeRuntime(true);
    runtime.handleSequence("N");

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "newSessionAction", actionId: "review.name" } },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect(view.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "editName" },
    });
    expect(station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
    expect(written).toEqual([]);
  });

  it("gives bounded-screen barriers first refusal without opening a context menu", () => {
    const { view, station, runtime } = makeRuntime(true);
    view.getState().handleKey({ input: "H" });

    for (const target of [{ kind: "screenBackdrop" }, { kind: "sheetBackdrop" }] as const) {
      expect(runtime.dispatchMouse({ kind: "station", target }, RIGHT_DOWN)).toBe(true);
      expect(runtime.dispatchMouse({ kind: "station", target }, WHEEL_UP)).toBe(true);
      expect(view.getState().screen).toEqual({ name: "help" });
      expect(station.getState().input.contextMenu).toBeNull();
    }

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "screenBackdrop" } },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect(view.getState().screen).toEqual({ name: "dashboard" });
    expect(station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
  });

  it("closes STATION from the backdrop through the runtime path", () => {
    const { station, runtime } = makeRuntime(true);

    expect(runtime.dispatchMouse({ kind: "stationBackdrop" }, LEFT_DOWN)).toBe(true);

    expect(station.getState().input.activeOverlay).toBeNull();
    expect(station.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("returns focus to welcome when backdrop-closing an empty workspace overlay", () => {
    const { station, runtime } = makeRuntime(true, { boot: "empty" });

    expect(runtime.dispatchMouse({ kind: "stationBackdrop" }, LEFT_DOWN)).toBe(true);

    expect(station.getState().input.activeOverlay).toBeNull();
    expect(station.getState().input.focus).toEqual({ kind: "welcome" });
  });

  it("consumes non-primary backdrop input without closing STATION", () => {
    const { station, runtime, written } = makeRuntime(true);

    expect(runtime.dispatchMouse({ kind: "stationBackdrop" }, RIGHT_DOWN)).toBe(true);
    expect(runtime.dispatchMouse({ kind: "stationBackdrop" }, WHEEL_UP)).toBe(true);

    expect(station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
    expect(station.getState().input.contextMenu).toBeNull();
    expect(written).toEqual([]);
  });

  it("ignores view mouse targets while the overlay is down", () => {
    const { view, runtime } = makeRuntime(false);

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      LEFT_DOWN,
    );
    expect([...view.getState().collapsedProjectIds]).toEqual([]);
  });

  it("keeps the header click toggle working while the overlay is open", () => {
    const { station, runtime } = makeRuntime(true);

    expect(runtime.dispatchMouse({ kind: "header" }, LEFT_DOWN)).toBe(true);
    expect(station.getState().input.activeOverlay).toBeNull();
  });

  it("opens a context menu for view right-click without firing the left-click action", () => {
    const { view, station, runtime } = makeRuntime(true);

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
        RIGHT_DOWN,
      ),
    ).toBe(true);

    expect([...view.getState().collapsedProjectIds]).toEqual([]);
    expect(station.getState().input.contextMenu).toMatchObject({
      target: { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      anchor: { x: 8, y: 4 },
    });
    expect(station.getState().input.focus).toEqual({ kind: "contextMenu" });
  });
});
