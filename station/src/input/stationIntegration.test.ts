// Layer conformance for the STATION dashboard registration: real normalized
// byte sequences through the real keymap stack and input runtime, against
// the real coordination store. Pins the stack semantics the spike plan
// documents — app-level exit/toggle chords pierce the overlay layer, pane
// management stays disabled, dismiss intents close via the
// coordination store, and terminal passthrough is untouched when the
// overlay is down.
import { describe, expect, it } from "bun:test";
import type { StationSnapshot } from "@station/contracts";
import { dashboardRowIds } from "@station/dashboard-core/selectors";
import { dashboardExecution } from "@station/dashboard-core/runtime";
import type { DashboardCapabilities } from "@station/dashboard-core/runtime";
import {
  makeStationTestRuntime,
  type StationTestDashboardRuntime,
} from "../station/test/support/makeStationTestRuntime.js";
import { createStationStore, type StationStore } from "../state/store.js";
import { MAIN_PANE_ID, STATION_OVERLAY_ID } from "../state/types.js";
import { groupedManyProjectsSnapshot } from "../station/fixtures/scenarios.js";
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
  station?: StationStore,
  options: {
    snapshot?: StationSnapshot;
    terminalRows?: number;
    activatedSessionIds?: string[];
  } = {},
): StationTestDashboardRuntime {
  const { activatedSessionIds, ...runtimeOptions } = options;
  const capabilities: DashboardCapabilities | undefined =
    station === undefined
      ? undefined
      : {
          activation: {
            activate: ({ sessionId }) => {
              activatedSessionIds?.push(sessionId);
              return dashboardExecution({ kind: "success" });
            },
          },
          managedSessions: {
            create: () => dashboardExecution({ kind: "success" }),
            quickCreate: () => dashboardExecution({ kind: "success" }),
            fork: () => dashboardExecution({ kind: "success" }),
          },
          shell: { open: () => dashboardExecution({ kind: "success" }) },
          dismissal: {
            dismissDashboard: () => {
              station.actions.closeOverlay();
              return dashboardExecution({ kind: "success" });
            },
            exitRenderer: () => {
              station.actions.closeOverlay();
              return dashboardExecution({ kind: "success" });
            },
          },
        };
  return makeStationTestRuntime({
    ...runtimeOptions,
    ...(capabilities === undefined ? {} : { capabilities }),
  }).runtime;
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
    expect(view.state.getState().screen).toEqual({ name: "help" });

    // Esc in help mode closes the MODE, not the overlay.
    expect(routeKey("\x1b", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("routes Group header and menu keys through the native keymap", () => {
    const snapshot = groupedManyProjectsSnapshot();
    const station = makeStationStore(true);
    const activatedSessionIds: string[] = [];
    const view = makeViewStore(station, { snapshot, terminalRows: 40, activatedSessionIds });
    const keymap = createStationKeymap(view);
    const groupId = dashboardRowIds.group("group_design_refresh");

    expect(routeKey("\x1b[B", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(routeKey("\x1b[B", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(view.state.getState().dashboardFocus).toEqual({ rowId: groupId, cellId: "identity" });

    routeKey("\x1b[C", station.getState(), keymap);
    routeKey("\r", station.getState(), keymap);
    expect(view.state.getState().dashboardFocus).toEqual({
      rowId: groupId,
      cellId: "quickSession",
    });
    expect([...view.state.getState().collapsedGroupIds]).toEqual([]);

    routeKey("\x1b[C", station.getState(), keymap);
    routeKey("\r", station.getState(), keymap);
    expect(view.state.getState().dashboardFocus).toEqual({ rowId: groupId, cellId: "menu" });
    expect([...view.state.getState().collapsedGroupIds]).toEqual([]);
    expect(view.state.getState().screen).toEqual({
      name: "groupMenu",
      projectId: "station",
      groupId: "group_design_refresh",
      focus: "quickSession",
    });

    routeKey("S", station.getState(), keymap);
    expect(view.state.getState().screen).toMatchObject({
      name: "groupSettings",
      groupId: "group_design_refresh",
      section: "general",
    });
    routeKey("\x1b", station.getState(), keymap);
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
    routeKey("a", station.getState(), keymap);
    expect(activatedSessionIds).toEqual(["ses_wt_runtime_cleanup"]);

    view.actions.dispatch({
      type: "dashboard.cell.activate",
      rowId: groupId,
      cellId: "identity",
    });
    expect([...view.state.getState().collapsedGroupIds]).toEqual(["group_design_refresh"]);
  });

  it("dispatches dashboard dismissal through native capability authority", () => {
    const station = makeStationStore(true);
    const view = makeViewStore(station);
    const keymap = createStationKeymap(view);

    expect(routeKey("\x1b", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(station.getState().input.activeOverlay).toBeNull();
    station.actions.openOverlay(STATION_OVERLAY_ID);
    expect(routeKey("Q", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    expect(station.getState().input.activeOverlay).toBeNull();
  });

  it("lets exit and toggle chords pierce the dashboard layer from any mode", () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);

    routeKey("/", station.getState(), keymap);
    expect(view.state.getState().screen).toMatchObject({ name: "persistentFilter" });

    expect(routeKey(OVERLAY_TOGGLE_LEGACY, station.getState(), keymap)).toEqual({
      kind: "overlay-close",
      overlayId: STATION_OVERLAY_ID,
    });
    expect(routeKey(STATION_EXIT_LEGACY, station.getState(), keymap)).toEqual({
      kind: "command",
      commandId: "station.exit",
    });
    // The filter editor never saw the chords as draft text.
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "", cursor: 0 },
    });
  });

  it("dispatches direct C through the semantic managed-session capability", async () => {
    const view = makeViewStore();
    const station = makeStationStore(true);
    const keymap = createStationKeymap(view);
    routeKey("N", station.getState(), keymap);
    routeKey("\x1b[B", station.getState(), keymap);

    expect(routeKey("C", station.getState(), keymap)).toEqual({ kind: "swallowed" });
    await waitFor(() => view.state.getState().screen.name === "dashboard");
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
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
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "a", cursor: 1 },
    });
  });

  it("leaves terminal passthrough untouched while the overlay is down", () => {
    const view = makeViewStore();
    const station = makeStationStore(false);
    const keymap = createStationKeymap(view);

    expect(routeKey("H", station.getState(), keymap)).toMatchObject({
      kind: "terminal-write",
      bytes: "H",
    });
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
  });
});

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("station input through the station runtime", () => {
  function makeRuntime(
    overlayOpen: boolean,
    options: {
      boot?: "empty";
    } = {},
  ) {
    const station = makeStationStore(overlayOpen, options);
    const view = makeViewStore(station);
    const written: string[] = [];
    const pasted: string[] = [];
    const runtime = createStationInputRuntime({
      store: station,
      shutdown: () => {},
      dashboardRuntime: view,
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
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "p", cursor: 1 },
    });

    expect(runtime.handleSequence("\x1b")).toBe(true); // cancel filter
    expect(runtime.handleSequence("\x1b")).toBe(true); // dismiss overlay
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(station.getState().input.focus.kind).toBe("pane");
  });

  it("drives persistent filter cancel, apply, retained close, and clear through the runtime", () => {
    const { view, station, runtime } = makeRuntime(true);

    expect(runtime.handleSequence("/")).toBe(true);
    expect(runtime.handleSequence("working")).toBe(true);
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "working", cursor: 7 },
    });
    expect(runtime.handleSequence("\x1b")).toBe(true);
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
    expect(view.state.getState().persistentFilter).toBeUndefined();

    runtime.handleSequence("/");
    runtime.handleSequence("working");
    runtime.handleSequence("\r");
    expect(view.state.getState().persistentFilter).toEqual({ query: "working" });

    expect(runtime.handleSequence("Q")).toBe(true);
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(view.state.getState().persistentFilter).toEqual({ query: "working" });

    const clearing = makeRuntime(true);
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
    expect(clearing.view.state.getState().persistentFilter).toBeUndefined();
    expect(clearing.runtime.handleSequence("\x1b")).toBe(true);
    expect(clearing.station.getState().input.activeOverlay).toBeNull();
  });

  it("keeps condition input modal and click-away returns only to filter editing", () => {
    const { view, runtime } = makeRuntime(true);
    runtime.handleSequence("/");
    runtime.handleSequence("queue");
    runtime.handleSequence("\t");
    runtime.handleSequence("S");
    runtime.handleSequence("3");
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      conditionEditor: {
        stage: "values",
        field: "status",
        selectedIds: ["working"],
      },
    });

    runtime.dispatchMouse(
      { kind: "station", target: { kind: "screenBackdrop" } },
      LEFT_DOWN,
    );

    expect(view.state.getState().screen).toEqual({
      name: "persistentFilter",
      draft: { value: "queue", cursor: 5 },
      draftConditions: [],
    });
  });

  it("swallows condition-panel right clicks without opening the workspace context menu", () => {
    const { view, station, runtime } = makeRuntime(true);
    runtime.handleSequence("/");
    runtime.handleSequence("\t");
    runtime.handleSequence("S");
    const before = view.state.getState().screen;

    for (const target of [
      {
        kind: "persistentFilterConditionValue" as const,
        field: "status" as const,
        valueId: "working",
      },
      { kind: "persistentFilterConditionAction" as const, actionId: "done" as const },
    ]) {
      runtime.dispatchMouse({ kind: "station", target }, RIGHT_DOWN);
      expect(view.state.getState().screen).toEqual(before);
      expect(station.getState().input.contextMenu).toBeNull();
    }
  });

  it("routes applied-filter footer targets through the runtime without piercing modals", () => {
    const { view, runtime } = makeRuntime(true);
    runtime.handleSequence("/");
    runtime.handleSequence("working");
    runtime.handleSequence("\r");

    expect(
      runtime.dispatchMouse(
        {
          kind: "station",
          target: { kind: "persistentFilterAction", actionId: "persistentFilter.edit" },
        },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect(view.state.getState().screen).toMatchObject({ name: "persistentFilter" });

    runtime.handleSequence("\x1b");
    runtime.handleSequence("H");
    runtime.dispatchMouse(
      {
        kind: "station",
        target: { kind: "persistentFilterAction", actionId: "persistentFilter.clear" },
      },
      LEFT_DOWN,
    );
    expect(view.state.getState().screen).toEqual({ name: "help" });
    expect(view.state.getState().persistentFilter).toEqual({ query: "working" });

    runtime.handleSequence("\x1b");
    runtime.dispatchMouse(
      {
        kind: "station",
        target: { kind: "persistentFilterAction", actionId: "persistentFilter.clear" },
      },
      LEFT_DOWN,
    );
    expect(view.state.getState().persistentFilter).toBeUndefined();
  });

  it("sanitizes persistent-filter paste and reserves global chords from the draft", () => {
    const { view, station, runtime } = makeRuntime(true);
    runtime.handleSequence("/");

    runtime.handlePaste({
      bytes: new TextEncoder().encode("sta\x1b[31mtion\x00\nover\rlay\x07"),
      preventDefault: () => {},
    });
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "sta[31mtion over lay" },
    });

    expect(runtime.handleSequence(OVERLAY_TOGGLE_LEGACY)).toBe(true);
    expect(station.getState().input.activeOverlay).toBeNull();
    expect(view.state.getState().screen).toMatchObject({
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

    const screen = view.state.getState().screen;
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
    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "station-overlay" },
    });
  });

  it("strips control bytes from pastes so they cannot leak into text inputs", () => {
    const { view, runtime } = makeRuntime(true);
    runtime.handleSequence("/");

    runtime.handlePaste({
      bytes: new TextEncoder().encode("sta\x1b[31mtion\x00\nover\rlay\x07"),
      preventDefault: () => {},
    });

    expect(view.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draft: { value: "sta[31mtion over lay" },
    });
  });

  it("routes view mouse targets through the active overlay", () => {
    const { view, station, runtime } = makeRuntime(true);

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect([...view.state.getState().collapsedProjectIds]).toEqual(["station"]);
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
    expect(view.state.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "editName" },
    });
    expect(station.getState().input.activeOverlay).toBe(STATION_OVERLAY_ID);
    expect(written).toEqual([]);
  });

  it("gives bounded-screen barriers first refusal without opening a context menu", () => {
    const { view, station, runtime } = makeRuntime(true);
    view.actions.handleKey({ input: "H" });

    for (const target of [{ kind: "screenBackdrop" }, { kind: "sheetBackdrop" }] as const) {
      expect(runtime.dispatchMouse({ kind: "station", target }, RIGHT_DOWN)).toBe(true);
      expect(runtime.dispatchMouse({ kind: "station", target }, WHEEL_UP)).toBe(true);
      expect(view.state.getState().screen).toEqual({ name: "help" });
      expect(station.getState().input.contextMenu).toBeNull();
    }

    expect(
      runtime.dispatchMouse(
        { kind: "station", target: { kind: "screenBackdrop" } },
        LEFT_DOWN,
      ),
    ).toBe(true);
    expect(view.state.getState().screen).toEqual({ name: "dashboard" });
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
      { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      LEFT_DOWN,
    );
    expect([...view.state.getState().collapsedProjectIds]).toEqual([]);
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
        { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
        RIGHT_DOWN,
      ),
    ).toBe(true);

    expect([...view.state.getState().collapsedProjectIds]).toEqual([]);
    expect(station.getState().input.contextMenu).toMatchObject({
      target: { kind: "station", target: { kind: "dashboardCell", rowId: dashboardRowIds.project("station"), cellId: "identity" } },
      anchor: { x: 8, y: 4 },
    });
    expect(station.getState().input.focus).toEqual({ kind: "contextMenu" });
  });
});
