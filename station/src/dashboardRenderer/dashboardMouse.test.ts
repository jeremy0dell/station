import { describe, expect, it } from "bun:test";
import type { StationSnapshot } from "@station/contracts";
import {
  addTuiToast,
  createEditableTextInputState,
  openProjectSettings,
  removeProjectConfirmPhrase,
  selectDashboardViewport,
  type TuiStore,
} from "@station/dashboard-core";
import type { StoreApi } from "zustand/vanilla";
import type { StationMouseEvent } from "../input/mouse.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import {
  type DashboardMouseEffects,
  routeDashboardMouse as routeDashboardMouseWithEffects,
} from "./dashboardMouse.js";

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 10,
  y: 5,
  modifiers: { shift: false, alt: false, ctrl: false },
};
const LEFT_UP: StationMouseEvent = { ...LEFT_DOWN, type: "up" };
const RIGHT_DOWN: StationMouseEvent = { ...LEFT_DOWN, button: "right", rawButton: 2 };
const MIDDLE_DOWN: StationMouseEvent = { ...LEFT_DOWN, button: "middle", rawButton: 1 };
const TEST_EFFECTS: DashboardMouseEffects = {
  openShell: () => {},
  openUrl: () => {},
};
const DASHBOARD_MOUSE_TARGET_KINDS = {
  addProjectRow: true,
  body: true,
  link: true,
  openShellForProject: true,
  openShellForRow: true,
  projectHeader: true,
  projectSettingsConfirmRemove: true,
  projectSettingsItem: true,
  quickSessionForProject: true,
  row: true,
  scrollIndicator: true,
  sheetBackdrop: true,
  sheetButton: true,
  sheetChoice: true,
  sheetSubmit: true,
  showDefaultAgentPickerForProject: true,
  toast: true,
  widgetSettingsAdd: true,
  widgetSettingsOpen: true,
  widgetSettingsPickerChoice: true,
  widgetSettingsRemove: true,
  widgetSettingsRow: true,
} satisfies Record<StationMouseTarget["kind"], true>;

const SCROLL_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  type: "scroll",
  button: "wheel-down",
  rawButton: 5,
  scrollDirection: "down",
};

function routeDashboardMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  store: StoreApi<TuiStore>,
  effects: DashboardMouseEffects = TEST_EFFECTS,
): void {
  routeDashboardMouseWithEffects(target, event, store, effects);
}

function makeStore(snapshot?: StationSnapshot): StoreApi<TuiStore> {
  return makeStationTestStore({
    terminalRows: 14,
    ...(snapshot === undefined ? {} : { snapshot }),
  }).store;
}

function slotForRow(store: StoreApi<TuiStore>, rowId: string): string {
  const state = store.getState();
  if (state.snapshot === undefined) throw new Error("store has no snapshot");
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) throw new Error(`no slot for row ${rowId}`);
  return choice.key;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("routeDashboardMouse", () => {
  it("keeps the standalone target vocabulary compile-time exhaustive", () => {
    expect(Object.values(DASHBOARD_MOUSE_TARGET_KINDS).every(Boolean)).toBe(true);
  });

  it("activates the exact current row through its keyboard slot", () => {
    const clicked = makeStore();
    const keyed = makeStore();
    const rowId = "ses_wt_station_none";

    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, clicked);
    keyed.getState().handleKey({ input: slotForRow(keyed, rowId) });

    expect(clicked.getState().localRows.pendingStart).toMatchObject(
      keyed.getState().localRows.pendingStart.map(({ createdAt: _createdAt, ...row }) => row),
    );
    expect(clicked.getState().localRows.pendingStart).toMatchObject([
      { worktreeId: "wt_station_none", operation: "startAgent" },
    ]);
  });

  it("never redirects a stale row target to the row that replaced its slot", () => {
    const snapshot = manyProjectsSnapshot();
    const store = makeStore(snapshot);
    const staleRowId = "ses_wt_station_idle";
    const staleSession = snapshot.sessions.find((session) => session.id === staleRowId);
    if (staleSession === undefined) throw new Error("fixture session missing");
    store.setState({
      snapshot: {
        ...snapshot,
        sessions: snapshot.sessions.filter((session) => session.id !== staleSession.id),
      },
    });

    routeDashboardMouse({ kind: "row", rowId: staleRowId }, LEFT_DOWN, store);

    expect(store.getState().localRows.pendingStart).toEqual([]);
    expect(store.getState().toasts.at(-1)?.toast.message).toBe(
      "That dashboard item is no longer available.",
    );
  });

  it("keeps pending rows inert without stale-item feedback", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_none";
    store.getState().handleKey({ input: slotForRow(store, rowId) });

    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);

    expect(store.getState().localRows.pendingStart).toHaveLength(1);
    expect(store.getState().toasts).toEqual([]);
  });

  it("toggles a current project exactly once and clamps scroll", () => {
    const store = makeStore();
    store.setState({ scrollOffset: 99 });

    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_UP, store);

    expect([...store.getState().collapsedProjectIds]).toEqual(["station"]);
    expect(store.getState().scrollOffset).toBeLessThan(99);
  });

  it("routes wheel over child targets and blocks background scrolling in modal modes", () => {
    const store = makeStore();

    routeDashboardMouse(
      { kind: "row", rowId: "ses_wt_station_working" },
      SCROLL_DOWN,
      store,
    );
    expect(store.getState().scrollOffset).toBe(1);

    store.getState().handleKey({ input: "H" });
    routeDashboardMouse(
      { kind: "row", rowId: "ses_wt_station_working" },
      SCROLL_DOWN,
      store,
    );
    expect(store.getState().scrollOffset).toBe(1);
  });

  it("maps row pickers, sheet choices, confirmations, and fork submit to keyboard transitions", async () => {
    const store = makeStore();
    const rowId = "ses_wt_station_working";

    store.getState().handleKey({ input: "X" });
    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({ name: "removeWorktree", step: "confirm" });
    routeDashboardMouse({ kind: "sheetButton", key: "n" }, LEFT_DOWN, store);
    expect(store.getState().screen).toEqual({ name: "dashboard" });

    store.getState().handleKey({ input: "N" });
    store.getState().handleKey({ input: "P" });
    routeDashboardMouse({ kind: "sheetChoice", choiceKey: "1" }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({ name: "newSession", flow: { mode: "review" } });
    store.getState().handleKey({ input: "", escape: true });

    store.getState().handleKey({ input: "F" });
    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "sheetSubmit" }, LEFT_DOWN, store);
    await waitFor(() => store.getState().screen.name === "dashboard");
  });

  it("maps project settings, add-project, toast, scroll-indicator, and widget targets", async () => {
    const fixture = makeStationTestStore({ terminalRows: 14 });
    const store = fixture.store;

    store.setState(openProjectSettings(store.getState(), "station"));
    routeDashboardMouse({ kind: "projectSettingsItem", itemId: "remove" }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({
      name: "projectSettings",
      activeId: "remove",
      focus: "detail",
    });
    store.setState({
      screen: {
        name: "projectSettings",
        projectId: "station",
        focus: "detail",
        activeId: "remove",
        removeDraft: createEditableTextInputState(removeProjectConfirmPhrase("station")),
      },
    });
    routeDashboardMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store);
    await waitFor(() => store.getState().screen.name === "dashboard");

    store.getState().handleKey({ input: "A" });
    routeDashboardMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    const addProject = store.getState().screen;
    expect(addProject.name === "addProject" && addProject.flow.mode === "start" && addProject.flow.selectedIndex).toBe(1);
    store.getState().handleKey({ input: "", escape: true });

    store.setState({ widgets: [{ type: "time" }, { type: "moon" }] });
    store.setState({ screen: { name: "dashboard" } });
    routeDashboardMouse({ kind: "widgetSettingsOpen" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsRow", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().widgets[1]).toEqual({ type: "moon", enabled: false });
    routeDashboardMouse({ kind: "widgetSettingsRemove", index: 0 }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsAdd" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsPickerChoice", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().widgets.map((widget) => widget.type)).toEqual(["moon", "fleet"]);

    store.setState({ screen: { name: "dashboard" }, scrollOffset: 0 });
    routeDashboardMouse({ kind: "scrollIndicator", direction: "down" }, LEFT_DOWN, store);
    expect(store.getState().scrollOffset).toBe(5);
    store.setState(addTuiToast(store.getState(), { kind: "info", message: "hello" }));
    routeDashboardMouse({ kind: "toast" }, LEFT_DOWN, store);
    expect(store.getState().toasts).toEqual([]);
  });

  it("routes project shell, quick-session, and agent-picker actions", async () => {
    const fixture = makeStationTestStore({ terminalRows: 14 });
    const store = fixture.store;
    const openedShells: string[] = [];
    const effects = {
      openShell: ({ cwd }: { cwd: string }) => openedShells.push(cwd),
      openUrl: () => {},
    };

    routeDashboardMouse(
      { kind: "openShellForProject", projectId: "station" },
      LEFT_DOWN,
      store,
      effects,
    );
    routeDashboardMouse(
      { kind: "openShellForRow", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      store,
      effects,
    );
    expect(openedShells).toEqual([
      "/Users/example/Developer/station",
      "/Users/example/.worktrees/station/pty-buffer",
    ]);

    routeDashboardMouse(
      { kind: "quickSessionForProject", projectId: "station" },
      LEFT_DOWN,
      store,
      effects,
    );
    await waitFor(() =>
      fixture.service.dispatched.some((command) => command.type === "session.create"),
    );
    expect(fixture.service.dispatched.find((command) => command.type === "session.create")).toMatchObject({
      payload: {
        projectId: "station",
        harness: { provider: "codex" },
        terminal: { provider: "tmux" },
      },
    });

    routeDashboardMouse(
      { kind: "showDefaultAgentPickerForProject", projectId: "station" },
      LEFT_DOWN,
      store,
      effects,
    );
    expect(store.getState().screen).toMatchObject({
      name: "projectDefaultAgent",
      projectId: "station",
    });
  });

  it("ignores mouse-up, right, middle, and modal background actions", () => {
    const store = makeStore();
    const before = store.getState();

    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_UP, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, RIGHT_DOWN, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, MIDDLE_DOWN, store);
    expect(store.getState().screen).toEqual(before.screen);
    expect(store.getState().collapsedProjectIds).toEqual(before.collapsedProjectIds);

    store.getState().handleKey({ input: "H" });
    routeDashboardMouse(
      { kind: "row", rowId: "ses_wt_station_none" },
      LEFT_DOWN,
      store,
    );
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect(store.getState().screen).toEqual({ name: "help" });
    expect(store.getState().localRows.pendingStart).toEqual([]);
    expect(store.getState().collapsedProjectIds.size).toBe(0);
  });

  it("opens links through the renderer effect and keeps stale-target feedback bounded", () => {
    const store = makeStore();
    const openedUrls: string[] = [];
    const effects = {
      openShell: () => {},
      openUrl: (url: string) => openedUrls.push(url),
    };

    for (let index = 0; index < 10; index += 1) {
      routeDashboardMouse(
        { kind: "link", url: "https://github.com/example/station/pull/12" },
        LEFT_DOWN,
        store,
        effects,
      );
      routeDashboardMouse({ kind: "row", rowId: `stale-${index}` }, LEFT_DOWN, store, effects);
    }

    expect(openedUrls).toEqual(
      Array.from({ length: 10 }, () => "https://github.com/example/station/pull/12"),
    );
    expect(store.getState().toasts.length).toBeLessThanOrEqual(3);
    expect(store.getState().toasts.some((entry) =>
      entry.toast.message === "That dashboard item is no longer available."
    )).toBe(true);
  });
});
