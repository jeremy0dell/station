import { describe, expect, it } from "bun:test";
import type { StationSnapshot } from "@station/contracts";
import {
  addProjectSelectedIndex,
  removeProjectConfirmPhrase,
  selectDashboardViewport,
  type DashboardRuntimeOptions,
} from "@station/dashboard-core";
import type { StationMouseEvent } from "../input/mouse.js";
import type { StationMouseTarget } from "../station/input/stationMouse.js";
import {
  manyProjectsSnapshot,
  noProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import {
  makeStationTestRuntime,
  type StationTestDashboardRuntime,
} from "../station/test/support/makeStationTestRuntime.js";
type DashboardRendererEffects = {
  openShell(target: { cwd: string }): void;
  openUrl(url: string): void;
};
import * as dashboardMouse from "./dashboardMouse.js";

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
const TEST_EFFECTS: DashboardRendererEffects = {
  openShell: () => {},
  openUrl: () => {},
};
const DASHBOARD_MOUSE_TARGET_KINDS = {
  addProjectAction: true,
  addProjectRow: true,
  body: true,
  emptyProjectAction: true,
  firstProjectAdd: true,
  link: true,
  newSessionAction: true,
  openShellForProject: true,
  openShellForRow: true,
  persistentFilterAction: true,
  persistentFilterConditionAction: true,
  persistentFilterConditionField: true,
  persistentFilterConditionValue: true,
  projectHeader: true,
  projectSettingsConfirmRemove: true,
  removeWorktreeAction: true,
  projectSettingsItem: true,
  quickSessionForProject: true,
  renameSessionSubmit: true,
  row: true,
  screenBackdrop: true,
  scrollIndicator: true,
  sheetBackdrop: true,
  sheetChoice: true,
  forkSessionAction: true,
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
  store: StationTestDashboardRuntime,
  effects: DashboardRendererEffects = TEST_EFFECTS,
): void {
  dashboardMouse.routeDashboardMouse(target, event, store, effects.openUrl);
}

function makeStore(
  snapshot?: StationSnapshot,
  initialState?: DashboardRuntimeOptions["initialState"],
): StationTestDashboardRuntime {
  return makeStationTestRuntime({
    terminalRows: 14,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(initialState === undefined ? {} : { initialState }),
  }).runtime;
}

function slotForRow(store: StationTestDashboardRuntime, rowId: string): string {
  const state = store.state.getState();
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
    keyed.actions.handleKey({ input: slotForRow(keyed, rowId) });

    expect(clicked.state.getState().localRows.pendingStart).toMatchObject(
      keyed.state.getState().localRows.pendingStart.map(({ createdAt: _createdAt, ...row }) => row),
    );
    expect(clicked.state.getState().localRows.pendingStart).toMatchObject([
      { worktreeId: "wt_station_none", operation: "startAgent" },
    ]);
  });

  it("never redirects a stale row target to the row that replaced its slot", () => {
    const snapshot = manyProjectsSnapshot();
    const staleRowId = "ses_wt_station_idle";
    const staleSession = snapshot.sessions.find((session) => session.id === staleRowId);
    if (staleSession === undefined) throw new Error("fixture session missing");
    const store = makeStore({
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.id !== staleSession.id),
    });

    routeDashboardMouse({ kind: "row", rowId: staleRowId }, LEFT_DOWN, store);

    expect(store.state.getState().localRows.pendingStart).toEqual([]);
    expect(store.state.getState().toasts.at(-1)?.toast.message).toBe(
      "That dashboard item is no longer available.",
    );
  });

  it("keeps pending rows inert without stale-item feedback", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_none";
    store.actions.handleKey({ input: slotForRow(store, rowId) });

    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);

    expect(store.state.getState().localRows.pendingStart).toHaveLength(1);
    expect(store.state.getState().toasts).toEqual([]);
  });

  it("toggles a current project exactly once and clamps scroll", () => {
    const store = makeStore(undefined, { scrollOffset: 99 });

    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_UP, store);

    expect([...store.state.getState().collapsedProjectIds]).toEqual(["station"]);
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "primary",
    });
    expect(store.state.getState().scrollOffset).toBeLessThan(99);
  });

  it("routes wheel over child targets and blocks background scrolling in modal modes", () => {
    const store = makeStore();

    routeDashboardMouse({ kind: "row", rowId: "ses_wt_station_working" }, SCROLL_DOWN, store);
    expect(store.state.getState().scrollOffset).toBe(1);

    store.actions.handleKey({ input: "H" });
    routeDashboardMouse({ kind: "row", rowId: "ses_wt_station_working" }, SCROLL_DOWN, store);
    expect(store.state.getState().scrollOffset).toBe(1);
  });

  it("dismisses a bounded screen only on primary-down and keeps stale backdrop wheels inert", () => {
    const store = makeStore();
    store.actions.handleKey({ input: "H" });

    for (const event of [LEFT_UP, RIGHT_DOWN, MIDDLE_DOWN, SCROLL_DOWN]) {
      routeDashboardMouse({ kind: "screenBackdrop" }, event, store);
      expect(store.state.getState().screen).toEqual({ name: "help" });
    }

    routeDashboardMouse({ kind: "screenBackdrop" }, LEFT_DOWN, store);
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });

    routeDashboardMouse({ kind: "screenBackdrop" }, SCROLL_DOWN, store);
    routeDashboardMouse({ kind: "sheetBackdrop" }, SCROLL_DOWN, store);
    expect(store.state.getState().scrollOffset).toBe(0);
  });

  it("routes condition header and footer controls through the standalone renderer", () => {
    const doneStore = makeStationTestRuntime({
      terminalRows: 14,
    }).runtime;
    doneStore.actions.handleKey({ input: "/" });
    doneStore.actions.handleKey({ input: "i", ctrl: true });
    doneStore.actions.handleKey({ input: "S" });
    doneStore.actions.handleKey({ input: "3" });

    routeDashboardMouse(
      { kind: "persistentFilterConditionAction", actionId: "done" },
      LEFT_DOWN,
      doneStore,
    );
    expect(doneStore.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      draftConditions: [
        { field: "status", values: [{ id: "working", label: "Working" }] },
      ],
      conditionEditor: { stage: "field", cursor: 0 },
    });
    routeDashboardMouse(
      { kind: "persistentFilterConditionAction", actionId: "applyFilter" },
      LEFT_DOWN,
      doneStore,
    );
    expect(doneStore.state.getState().screen).toEqual({ name: "dashboard" });
    expect(doneStore.state.getState().persistentFilter).toMatchObject({
      conditions: [{ field: "status" }],
    });

    const backStore = makeStationTestRuntime({
      terminalRows: 14,
    }).runtime;
    backStore.actions.handleKey({ input: "/" });
    backStore.actions.handleKey({ input: "i", ctrl: true });
    backStore.actions.handleKey({ input: "S" });
    routeDashboardMouse(
      { kind: "persistentFilterConditionAction", actionId: "back" },
      LEFT_DOWN,
      backStore,
    );
    expect(backStore.state.getState().screen).toMatchObject({
      name: "persistentFilter",
      conditionEditor: { stage: "field", cursor: 0 },
    });
  });

  it("opens first-project onboarding from the empty-dashboard CTA", () => {
    const empty = makeStore(noProjectsSnapshot());
    routeDashboardMouse({ kind: "firstProjectAdd" }, LEFT_DOWN, empty);
    expect(empty.state.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "start", firstProject: true },
    });

    const populated = makeStore();
    routeDashboardMouse({ kind: "firstProjectAdd" }, LEFT_DOWN, populated);
    expect(populated.state.getState().screen).toEqual({ name: "dashboard" });
  });

  it("maps row pickers, sheet choices, confirmations, and fork submit to keyboard transitions", async () => {
    const store = makeStore();
    const rowId = "ses_wt_station_working";

    store.actions.handleKey({ input: "X" });
    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);
    expect(store.state.getState().screen).toMatchObject({ name: "removeWorktree", step: "confirm" });
    routeDashboardMouse(
      { kind: "removeWorktreeAction", actionId: "confirm.keep" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });

    store.actions.handleKey({ input: "N" });
    store.actions.handleKey({ input: "P" });
    routeDashboardMouse({ kind: "sheetChoice", choiceKey: "1" }, LEFT_DOWN, store);
    expect(store.state.getState().screen).toMatchObject({ name: "newSession", flow: { mode: "review" } });
    store.actions.handleKey({ input: "", escape: true });

    store.actions.handleKey({ input: "F" });
    routeDashboardMouse({ kind: "row", rowId }, LEFT_DOWN, store);
    routeDashboardMouse(
      { kind: "forkSessionAction", actionId: "details.copyDirty" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "copyDirty",
      copyDirty: false,
    });
    routeDashboardMouse(
      { kind: "forkSessionAction", actionId: "details.name" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "name",
    });
    routeDashboardMouse(
      { kind: "forkSessionAction", actionId: "details.submit" },
      LEFT_DOWN,
      store,
    );
    await waitFor(() => store.state.getState().screen.name === "dashboard");
  });

  it("routes standalone Rename submit through the shared pointer router", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_idle";
    store.actions.handleKey({ input: "R" });
    store.actions.handleKey({ input: slotForRow(store, rowId) });
    store.actions.handleKey({ input: "Mouse title" });

    routeDashboardMouse({ kind: "renameSessionSubmit" }, LEFT_DOWN, store);

    expect(store.state.getState().screen).toEqual({ name: "dashboard" });
    expect(store.state.getState().localRows.pendingRenameTitles?.[rowId]?.title).toBe("Mouse title");
  });

  it("maps project settings, add-project, toast, scroll-indicator, and widget targets", async () => {
    const fixture = makeStationTestRuntime({
      terminalRows: 14,
      initialState: { widgets: [{ type: "time" }, { type: "moon" }] },
    });
    const store = fixture.runtime;

    store.actions.dispatch({ type: "projectSettings.open", projectId: "station" });
    routeDashboardMouse({ kind: "projectSettingsItem", itemId: "remove" }, LEFT_DOWN, store);
    expect(store.state.getState().screen).toMatchObject({
      name: "projectSettings",
      activeId: "remove",
      focus: "detail",
    });
    store.actions.handleKey({ input: removeProjectConfirmPhrase("station") });
    routeDashboardMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store);
    await waitFor(() => store.state.getState().screen.name === "dashboard");

    store.actions.handleKey({ input: "A" });
    routeDashboardMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    const addProject = store.state.getState().screen;
    expect(addProject.name === "addProject" && addProject.flow.mode === "start").toBe(true);
    expect(addProjectSelectedIndex(store.state.getState())).toBe(1);
    routeDashboardMouse(
      { kind: "addProjectAction", actionId: "start.cancel" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toEqual({ name: "dashboard" });

    routeDashboardMouse({ kind: "widgetSettingsOpen" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsRow", index: 1 }, LEFT_DOWN, store);
    expect(store.state.getState().widgets[1]).toEqual({ type: "moon", enabled: false });
    routeDashboardMouse({ kind: "widgetSettingsRemove", index: 0 }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsAdd" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "widgetSettingsPickerChoice", index: 1 }, LEFT_DOWN, store);
    expect(store.state.getState().widgets.map((widget) => widget.type)).toEqual(["moon", "fleet"]);

    store.actions.handleKey({ input: "", escape: true });
    routeDashboardMouse({ kind: "scrollIndicator", direction: "down" }, LEFT_DOWN, store);
    expect(store.state.getState().scrollOffset).toBe(5);
    store.actions.pushToast({ kind: "info", message: "hello" });
    routeDashboardMouse({ kind: "toast" }, LEFT_DOWN, store);
    expect(store.state.getState().toasts).toEqual([]);
  });

  it("routes Create Session fields, editor controls, and standalone Create", async () => {
    const fixture = makeStationTestRuntime({ terminalRows: 14 });
    const store = fixture.runtime;
    store.actions.handleKey({ input: "N" });

    routeDashboardMouse(
      { kind: "newSessionAction", actionId: "review.agent" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "pickAgent" },
    });
    store.actions.handleKey({ input: "", escape: true });

    routeDashboardMouse(
      { kind: "newSessionAction", actionId: "review.name" },
      LEFT_DOWN,
      store,
    );
    store.actions.handleKey({ input: "Standalone mouse" });
    routeDashboardMouse(
      { kind: "newSessionAction", actionId: "editName.save" },
      LEFT_DOWN,
      store,
    );
    expect(store.state.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review", title: "Standalone mouse" },
    });

    routeDashboardMouse(
      { kind: "newSessionAction", actionId: "review.create" },
      LEFT_DOWN,
      store,
    );
    await waitFor(() =>
      fixture.service.dispatched.some((command) => command.type === "session.create"),
    );
    const creates = fixture.service.dispatched.filter(
      (command) => command.type === "session.create",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      payload: { title: "Standalone mouse", harness: { provider: "codex" } },
    });
  });

  it("routes an empty-project click through Quick Session and transfers successful focus", async () => {
    const fixture = makeStationTestRuntime({ terminalRows: 40 });
    const store = fixture.runtime;

    routeDashboardMouse(
      { kind: "emptyProjectAction", projectId: "empty-project" },
      LEFT_DOWN,
      store,
    );

    await waitFor(() =>
      fixture.service.dispatched.some((command) => command.type === "session.create"),
    );
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "empty-project",
    });
    const creates = fixture.service.dispatched.filter(
      (command) => command.type === "session.create",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ payload: { projectId: "empty-project" } });
  });

  it("guards blocked, stale, and modal empty-project clicks", () => {
    const snapshot = manyProjectsSnapshot();
    const blockedSnapshot: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === "empty-project"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const blockedFixture = makeStationTestRuntime({ snapshot: blockedSnapshot, terminalRows: 40 });
    routeDashboardMouse(
      { kind: "emptyProjectAction", projectId: "empty-project" },
      LEFT_DOWN,
      blockedFixture.runtime,
    );
    expect(blockedFixture.runtime.state.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "empty-project",
    });
    expect(blockedFixture.runtime.state.getState().toasts.at(-1)?.toast.kind).toBe("error");
    expect(blockedFixture.service.dispatched).toEqual([]);

    const stale = makeStore();
    routeDashboardMouse({ kind: "emptyProjectAction", projectId: "ghost" }, LEFT_DOWN, stale);
    routeDashboardMouse({ kind: "emptyProjectAction", projectId: "station" }, LEFT_DOWN, stale);
    expect(stale.state.getState().dashboardFocus).toBeUndefined();

    const modal = makeStore();
    modal.actions.handleKey({ input: "H" });
    routeDashboardMouse(
      { kind: "emptyProjectAction", projectId: "empty-project" },
      LEFT_DOWN,
      modal,
    );
    expect(modal.state.getState().screen).toEqual({ name: "help" });
    expect(modal.state.getState().dashboardFocus).toBeUndefined();
  });

  it("dispatches shell semantics without reading stale dashboard projection", () => {
    const fixture = makeStationTestRuntime({ terminalRows: 14 });
    const canonical = manyProjectsSnapshot();
    const canonicalRoot = "/canonical/station";
    const canonicalWorktree = "/canonical/station/pty-buffer";
    fixture.source.setSnapshot({
      ...canonical,
      projects: canonical.projects.map((project) =>
        project.id === "station" ? { ...project, root: canonicalRoot } : project,
      ),
      rows: canonical.rows.map((row) =>
        row.id === "wt_station_idle" ? { ...row, path: canonicalWorktree } : row,
      ),
    });
    const openedShells: string[] = [];
    const effects = {
      openShell: ({ cwd }: { cwd: string }) => openedShells.push(cwd),
      openUrl: () => {},
    };

    routeDashboardMouse(
      { kind: "openShellForProject", projectId: "station" },
      LEFT_DOWN,
      fixture.runtime,
      effects,
    );
    routeDashboardMouse(
      { kind: "openShellForRow", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      fixture.runtime,
      effects,
    );

    expect(fixture.runtime.state.getState().snapshot?.projects[0]?.root).not.toBe(canonicalRoot);
    expect(fixture.runtime.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "shell",
    });
  });

  it("routes project shell, quick-session, and agent-picker actions", async () => {
    const fixture = makeStationTestRuntime({ terminalRows: 14 });
    const store = fixture.runtime;
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
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "shell",
    });

    routeDashboardMouse(
      { kind: "quickSessionForProject", projectId: "station" },
      LEFT_DOWN,
      store,
      effects,
    );
    await waitFor(() =>
      fixture.service.dispatched.some((command) => command.type === "session.create"),
    );
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "quickSession",
    });
    expect(
      fixture.service.dispatched.find((command) => command.type === "session.create"),
    ).toMatchObject({
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
    expect(store.state.getState().screen).toMatchObject({
      name: "projectDefaultAgent",
      projectId: "station",
    });
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "defaultAgent",
    });
  });

  it("resolves blocked Quick Session availability once at the standalone consumer", () => {
    const snapshot = manyProjectsSnapshot();
    const unavailable: StationSnapshot = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === "station"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const store = makeStore(unavailable);

    routeDashboardMouse(
      { kind: "quickSessionForProject", projectId: "station" },
      LEFT_DOWN,
      store,
    );

    expect(store.state.getState().localRows.pendingCreate).toEqual([]);
    expect(store.state.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "The worktree provider is unavailable.",
    });
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "quickSession",
    });
  });

  it("does not route shell execution through the URL presentation callback", () => {
    const store = makeStore();
    const effects: DashboardRendererEffects = {
      openShell: () => {
        throw new Error("shell unavailable");
      },
      openUrl: () => {},
    };

    expect(() =>
      routeDashboardMouse(
        { kind: "openShellForProject", projectId: "station" },
        LEFT_DOWN,
        store,
        effects,
      ),
    ).not.toThrow();
    expect(store.state.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "shell",
    });
  });

  it("ignores mouse-up, right, middle, and modal background actions", () => {
    const store = makeStore();
    const before = store.state.getState();

    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_UP, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, RIGHT_DOWN, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, MIDDLE_DOWN, store);
    expect(store.state.getState().screen).toEqual(before.screen);
    expect(store.state.getState().collapsedProjectIds).toEqual(before.collapsedProjectIds);

    store.actions.handleKey({ input: "H" });
    routeDashboardMouse({ kind: "row", rowId: "ses_wt_station_none" }, LEFT_DOWN, store);
    routeDashboardMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect(store.state.getState().screen).toEqual({ name: "help" });
    expect(store.state.getState().localRows.pendingStart).toEqual([]);
    expect(store.state.getState().collapsedProjectIds.size).toBe(0);
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
    expect(store.state.getState().toasts.length).toBeLessThanOrEqual(3);
    expect(
      store
        .state.getState()
        .toasts.some(
          (entry) => entry.toast.message === "That dashboard item is no longer available.",
        ),
    ).toBe(true);
  });
});
