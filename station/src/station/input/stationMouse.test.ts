// Pins the mouse router's modal guards to keyboard modality (the screen ×
// target matrix) and mouse/keyboard equivalence: a row click must produce
// exactly the state the row's slot key produces, in every mode where rows
// are interactive.
import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import type { ProviderId, StationSnapshot } from "@station/contracts";
import { selectDashboardViewport } from "@station/dashboard-core";
import { addTuiToast } from "@station/dashboard-core";
import {
  createEditableTextInputState,
  openProjectSettings,
  removeProjectConfirmPhrase,
} from "@station/dashboard-core";
import type { TuiStore } from "@station/dashboard-core";
import { agentWorktreePaneId } from "../../state/types.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import { manyProjectsSnapshot } from "../fixtures/scenarios.js";
import { makeStationTestStore } from "../test/support/makeStationTestStore.js";
import { resolveKeyRowAgentTarget, resolveRowAgentTarget } from "./stationActions.js";
import { routeStationMouse } from "./stationMouse.js";

const LEFT_DOWN: StationMouseEvent = {
  type: "down",
  button: "left",
  rawButton: 0,
  x: 10,
  y: 5,
  modifiers: { shift: false, alt: false, ctrl: false },
};

const RIGHT_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "right",
  rawButton: 2,
};

const SCROLL_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  type: "scroll",
  button: "wheel-down",
  rawButton: 5,
  scrollDirection: "down",
};

const SCROLL_UP: StationMouseEvent = {
  ...LEFT_DOWN,
  type: "scroll",
  button: "wheel-up",
  rawButton: 4,
  scrollDirection: "up",
};

function makeStore(snapshot?: StationSnapshot): StoreApi<TuiStore> {
  // Enough rows to keep the same visible window as before the pinned fleet bar +
  // column header, so the station-project rows stay slot-addressable.
  return makeStationTestStore({ terminalRows: 14, ...(snapshot === undefined ? {} : { snapshot }) })
    .store;
}

// A clone of the fixture with one project's default harness overridden. The
// managed launch no longer resolves the harness locally, so any harness id
// still produces a launch-managed outcome (the observer resolves it).
function snapshotWithHarness(projectId: string, harness: string): StationSnapshot {
  const base = manyProjectsSnapshot();
  return {
    ...base,
    projects: base.projects.map((project) =>
      project.id === projectId
        ? { ...project, defaults: { ...project.defaults, harness: harness as ProviderId } }
        : project,
    ),
  };
}

describe("routeStationMouse", () => {
  it("launches the row's primary agent (managed) on a dashboard row click", () => {
    const store = makeStore();
    const worktreeId = "wt_station_idle";
    const rowId = `ses_${worktreeId}`;

    const outcome = routeStationMouse({ kind: "row", rowId }, LEFT_DOWN, store);

    expect(outcome).toEqual({
      kind: "launch-managed",
      rowId,
      projectId: "station",
      worktreeId,
      paneId: agentWorktreePaneId(worktreeId),
      cwd: rowPath(worktreeId),
    });
    // The dashboard click no longer dispatches the start-or-focus slot key, so
    // no pending-start row is queued.
    expect(pendingStartIds(store)).toEqual([]);
  });

  it("emits launch-managed regardless of harness (the observer resolves it)", () => {
    const store = makeStore(snapshotWithHarness("station", "ghost"));

    const outcome = routeStationMouse(
      { kind: "row", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toMatchObject({ kind: "launch-managed", worktreeId: "wt_station_idle" });
    // No local toast: harness resolution (and any failure) is the observer's job now.
    expect(store.getState().toasts).toEqual([]);
  });

  it("treats a dashboard click on a stale row as an inert click with no toast", () => {
    const store = makeStore();

    const outcome = routeStationMouse({ kind: "row", rowId: "wt_nope" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().toasts).toEqual([]);
  });

  it("chooses the clicked row in remove mode, same as the slot key", () => {
    const clicked = makeStore();
    const keyed = makeStore();
    const rowId = "ses_wt_station_working";
    clicked.getState().handleKey({ input: "X" });
    keyed.getState().handleKey({ input: "X" });
    const slot = slotForRow(keyed, rowId);

    routeStationMouse({ kind: "row", rowId }, LEFT_DOWN, clicked);
    keyed.getState().handleKey({ input: slot });

    expect(clicked.getState().screen).toEqual(keyed.getState().screen);
    expect(clicked.getState().screen).toMatchObject({ name: "removeWorktree", step: "confirm" });
  });

  it("confirms remove with the sheet yes button", () => {
    const store = makeStore();
    const worktreeId = "wt_station_working";
    const rowId = `ses_${worktreeId}`;
    store.getState().handleKey({ input: "X" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });

    const outcome = routeStationMouse({ kind: "sheetButton", key: "y" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().localRows.pendingRemove).toMatchObject([
      { localId: `remove:${worktreeId}`, worktreeId },
    ]);
  });

  it("cancels remove with the sheet no button", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_working";
    store.getState().handleKey({ input: "X" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });

    const outcome = routeStationMouse({ kind: "sheetButton", key: "n" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().localRows.pendingRemove).toEqual([]);
  });

  it("ignores sheet buttons outside remove confirm mode", () => {
    const store = makeStore();
    const before = store.getState().screen;

    const outcome = routeStationMouse({ kind: "sheetButton", key: "y" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual(before);
    expect(store.getState().localRows.pendingRemove).toEqual([]);

    store.getState().handleKey({ input: "X" });
    routeStationMouse({ kind: "sheetButton", key: "y" }, LEFT_DOWN, store);
    expect(store.getState().screen).toEqual({ name: "removeWorktree", step: "chooseSlot" });
    expect(store.getState().localRows.pendingRemove).toEqual([]);
  });

  it("chooses the clicked row in fork mode, same as the slot key", () => {
    const clicked = makeStore();
    const keyed = makeStore();
    const rowId = "ses_wt_station_working";
    clicked.getState().handleKey({ input: "F" });
    keyed.getState().handleKey({ input: "F" });
    const slot = slotForRow(keyed, rowId);

    routeStationMouse({ kind: "row", rowId }, LEFT_DOWN, clicked);
    keyed.getState().handleKey({ input: slot });

    expect(clicked.getState().screen).toEqual(keyed.getState().screen);
    expect(clicked.getState().screen).toMatchObject({ name: "fork", step: "details" });
  });

  it("launches a fork from the sheet submit button", () => {
    const store = makeStore();
    const worktreeId = "wt_station_working";
    const rowId = `ses_${worktreeId}`;
    store.getState().handleKey({ input: "F" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });
    expect(store.getState().screen).toMatchObject({ name: "fork", step: "details" });

    const outcome = routeStationMouse({ kind: "sheetSubmit" }, LEFT_DOWN, store);

    expect(outcome.kind).toBe("launch-fork");
    if (outcome.kind === "launch-fork") {
      expect(outcome.projectId).toBe("station");
      expect(outcome.sourceWorktreeId).toBe(worktreeId);
      expect(outcome.copyDirty).toBe(true);
      expect(outcome.branch.length).toBeGreaterThan(0);
    }
    // The submit is intercepted, not dispatched to the machine — the sheet stays open
    // until the executor closes it, so the machine never ran the tmux session.fork.
    expect(store.getState().screen).toMatchObject({ name: "fork", step: "details" });
  });

  it("ignores sheet submit outside fork details mode", () => {
    const store = makeStore();
    const outcome = routeStationMouse({ kind: "sheetSubmit" }, LEFT_DOWN, store);
    expect(outcome).toEqual({ kind: "handled" });
  });

  it("ignores row clicks in text-input modes", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "/" });
    const before = store.getState();

    const outcome = routeStationMouse(
      { kind: "row", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual(before.screen);
    expect(store.getState().searchQuery).toBe(before.searchQuery);
  });

  it("toggles project collapse on header click, dashboard mode only", () => {
    const store = makeStore();

    routeStationMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect([...store.getState().collapsedProjectIds]).toEqual(["station"]);

    routeStationMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect([...store.getState().collapsedProjectIds]).toEqual([]);

    store.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect([...store.getState().collapsedProjectIds]).toEqual([]);
  });

  it("scrolls on wheel in row-interactive modes and nowhere else", () => {
    const store = makeStore();

    routeStationMouse({ kind: "body" }, SCROLL_DOWN, store);
    expect(store.getState().scrollOffset).toBe(1);
    routeStationMouse({ kind: "body" }, SCROLL_UP, store);
    expect(store.getState().scrollOffset).toBe(0);

    store.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "body" }, SCROLL_DOWN, store);
    expect(store.getState().scrollOffset).toBe(0);
  });

  it("never scrolls the dashboard under a sheet backdrop", () => {
    const store = makeStore();
    const outcome = routeStationMouse({ kind: "sheetBackdrop" }, SCROLL_DOWN, store);
    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().scrollOffset).toBe(0);
  });

  it("pages on scroll-indicator clicks", () => {
    const store = makeStore();
    routeStationMouse({ kind: "scrollIndicator", direction: "down" }, LEFT_DOWN, store);
    expect(store.getState().scrollOffset).toBe(5);
    routeStationMouse({ kind: "scrollIndicator", direction: "up" }, LEFT_DOWN, store);
    expect(store.getState().scrollOffset).toBe(0);
  });

  it("dismisses toasts on click in any mode", () => {
    const store = makeStore();
    store.setState(addTuiToast(store.getState(), { kind: "info", message: "hello" }));
    store.getState().handleKey({ input: "H" });

    routeStationMouse({ kind: "toast" }, LEFT_DOWN, store);

    expect(store.getState().toasts).toEqual([]);
  });

  it("selects sheet choices by their slot key in picker modes only", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "N" });
    store.getState().handleKey({ input: "P" });
    expect(store.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "pickProject" },
    });

    routeStationMouse({ kind: "sheetChoice", choiceKey: "1" }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review" },
    });

    // Outside picker modes a stray choice click is inert (no text injection).
    store.getState().handleKey({ input: "", escape: true });
    store.getState().handleKey({ input: "/" });
    routeStationMouse({ kind: "sheetChoice", choiceKey: "1" }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({ name: "search", value: "" });
  });

  it("dispatches footer hints as their binding's key, active mode only", () => {
    const store = makeStore();

    const helpClick = routeStationMouse(
      { kind: "footerHint", bindingId: "station.dashboard.help" },
      LEFT_DOWN,
      store,
    );
    expect(helpClick).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "help" });

    // The dashboard hint is stale while help is open: it must not fire.
    const stale = routeStationMouse(
      { kind: "footerHint", bindingId: "station.dashboard.search" },
      LEFT_DOWN,
      store,
    );
    expect(stale).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "help" });
  });

  it("reports close-overlay for dismiss hints so the router can close STATION mode", () => {
    const store = makeStore();
    const outcome = routeStationMouse(
      { kind: "footerHint", bindingId: "station.dashboard.dismiss" },
      LEFT_DOWN,
      store,
    );
    expect(outcome).toEqual({ kind: "close-overlay" });
  });

  it("treats right-click as inert at the STATION router layer", () => {
    const store = makeStore();
    const before = store.getState().screen;

    const outcome = routeStationMouse({ kind: "projectHeader", projectId: "station" }, RIGHT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toBe(before);
    expect([...store.getState().collapsedProjectIds]).toEqual([]);
  });

  it("opens PR links on plain left click in dashboard mode", () => {
    const store = makeStore();
    const url = "https://github.com/example/station/pull/12";

    expect(routeStationMouse({ kind: "link", url }, LEFT_DOWN, store)).toEqual({
      kind: "open-url",
      url,
    });

    store.getState().handleKey({ input: "/" });
    expect(routeStationMouse({ kind: "link", url }, LEFT_DOWN, store)).toEqual({ kind: "handled" });
  });

  it("opens a shell pane for a row click at the worktree path", () => {
    const store = makeStore();
    // Derive cwd from the live snapshot, not a duplicated path literal, so the
    // assertion proves the resolver reads row.path (not some equivalent format).
    const outcome = routeStationMouse(
      { kind: "openShellForRow", rowId: "ses_wt_station_idle" },
      LEFT_DOWN,
      store,
    );
    expect(outcome).toEqual({
      kind: "open-pane",
      paneId: "pane-wt-wt_station_idle",
      cwd: rowPath("wt_station_idle"),
      role: "shell",
      worktreeId: "wt_station_idle",
    });
  });

  it("opens a shell pane for a project header click at the project root", () => {
    const store = makeStore();
    const outcome = routeStationMouse({ kind: "openShellForProject", projectId: "station" }, LEFT_DOWN, store);
    expect(outcome).toEqual({
      kind: "open-pane",
      paneId: "pane-proj-station",
      cwd: projectRoot("station"),
      role: "shell",
    });
  });

  it("keeps [+sh] live on a worktree that has a pending agent start", () => {
    const store = makeStore();
    const worktreeId = "wt_station_none";
    const rowId = `ses_${worktreeId}`;
    // Put the row into a pending-start (transient) state via the start-or-focus
    // slot key: it drops out of rowChoices but still renders a clickable [+sh].
    // Opening a shell is orthogonal to agent activation, so the affordance must
    // still resolve the session's backing checkout. (The dashboard *mouse*
    // row-click opens the primary agent, so keyboard drives the pending start.)
    store.getState().handleKey({ input: slotForRow(store, rowId) });
    const outcome = routeStationMouse({ kind: "openShellForRow", rowId }, LEFT_DOWN, store);
    expect(outcome).toEqual({
      kind: "open-pane",
      paneId: `pane-wt-${worktreeId}`,
      cwd: rowPath(worktreeId),
      role: "shell",
      worktreeId,
    });
  });

  it("gates the open-shell affordance to dashboard mode", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "/" }); // enter search (non-dashboard) mode

    expect(routeStationMouse({ kind: "openShellForRow", rowId: "ses_wt_station_idle" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
    expect(
      routeStationMouse({ kind: "openShellForProject", projectId: "station" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
  });

  it("treats an unresolvable row or project as an inert click", () => {
    const store = makeStore();
    expect(routeStationMouse({ kind: "openShellForRow", rowId: "wt_nope" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
    expect(
      routeStationMouse({ kind: "openShellForProject", projectId: "ghost" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
  });

  it("creates a session immediately via [+] quick-session affordance", () => {
    const store = makeStore();
    const outcome = routeStationMouse({ kind: "quickSessionForProject", projectId: "station" }, LEFT_DOWN, store);
    expect(outcome.kind).toBe("launch-new-session");
    if (outcome.kind === "launch-new-session") {
      expect(outcome.projectId).toBe("station");
      expect(outcome.harness).toBe("codex"); // project.defaults.harness
      expect(outcome.branch).toMatch(/^station-[0-9a-f]+$/);
    }
  });

  it("gates quick-session and default-agent picker to dashboard mode", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "/" }); // enter search mode

    expect(
      routeStationMouse({ kind: "quickSessionForProject", projectId: "station" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
    expect(
      routeStationMouse(
        { kind: "showDefaultAgentPickerForProject", projectId: "station" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({ kind: "handled" });
  });

  it("treats an unresolvable project as an inert click for quick-session", () => {
    const store = makeStore();
    expect(
      routeStationMouse({ kind: "quickSessionForProject", projectId: "ghost" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
  });

  it("opens the project default-agent picker via [▾]", () => {
    const store = makeStore();
    const outcome = routeStationMouse(
      { kind: "showDefaultAgentPickerForProject", projectId: "station" },
      LEFT_DOWN,
      store,
    );
    // The outcome is handled (no router effect); the picker screen is set on the store.
    expect(outcome).toEqual({ kind: "handled" });
    const screen = store.getState().screen;
    expect(screen).toBeDefined();
    expect(screen?.name).toBe("projectDefaultAgent");
    if (screen?.name === "projectDefaultAgent") {
      expect(screen.projectId).toBe("station");
    }
  });

  it("selects a project default agent by clicking an agent picker row", async () => {
    const fixture = makeStationTestStore({ terminalRows: 12 });
    const store = fixture.store;
    routeStationMouse(
      { kind: "showDefaultAgentPickerForProject", projectId: "station" },
      LEFT_DOWN,
      store,
    );

    const outcome = routeStationMouse({ kind: "sheetChoice", choiceKey: "2" }, LEFT_DOWN, store);

    await waitFor(() => fixture.service.loadCount === 1);
    expect(outcome).toEqual({ kind: "handled" });
    expect(
      fixture.service.dispatched.some(
        (command) =>
          command.type === "project.setDefaultHarness" &&
          command.payload.projectId === "station" &&
          command.payload.harness === "opencode",
      ),
    ).toBe(true);
    expect(fixture.service.waitedForCommandIds).toEqual(["cmd_tui_1"]);
    const toast = store
      .getState()
      .toasts.find((entry) => entry.toast.message === "Default agent set to opencode.");
    expect(toast?.toast).toMatchObject({ kind: "success" });
  });

  it("silently ignores default-agent picker on absent or unavailable project", () => {
    const store = makeStore();
    // Ghost project: no mutation, no router effect.
    routeStationMouse(
      { kind: "showDefaultAgentPickerForProject", projectId: "ghost" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen?.name).not.toBe("projectDefaultAgent");
  });

  it("focuses a settings item on click and leaves an unarmed remove click inert", () => {
    const store = makeStore();
    store.setState(openProjectSettings(store.getState(), "station"));

    // Clicking a left-list item drops into its detail pane.
    routeStationMouse({ kind: "projectSettingsItem", itemId: "remove" }, LEFT_DOWN, store);
    expect(store.getState().screen).toMatchObject({
      name: "projectSettings",
      activeId: "remove",
      focus: "detail",
    });

    // Unarmed: the confirm click must not dispatch "r" (which the machine would
    // type into the confirm field) nor fire removal.
    const outcome = routeStationMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store);
    expect(outcome).toEqual({ kind: "handled" });
    const after = store.getState().screen;
    expect(after.name).toBe("projectSettings");
    if (after.name === "projectSettings") {
      expect(after.removeDraft.value).toBe("");
    }
  });

  it("fires removal when the armed remove confirmation is clicked", async () => {
    const fixture = makeStationTestStore({ terminalRows: 12 });
    const store = fixture.store;
    store.setState({
      ...store.getState(),
      screen: {
        name: "projectSettings",
        projectId: "station",
        focus: "detail",
        activeId: "remove",
        removeDraft: createEditableTextInputState(removeProjectConfirmPhrase("station")),
      },
    });

    const outcome = routeStationMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    await waitFor(() =>
      fixture.service.dispatched.some(
        (command) => command.type === "project.remove" && command.payload.projectId === "station",
      ),
    );
  });

  it("ignores project-settings targets outside projectSettings mode", () => {
    const store = makeStore();
    const before = store.getState().screen;

    expect(
      routeStationMouse({ kind: "projectSettingsItem", itemId: "remove" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
    expect(
      routeStationMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual(before);
  });
});

describe("resolveKeyRowAgentTarget", () => {
  it("resolves a row's slot key to the exact launch its click resolves", () => {
    // The keyboard "open" and the click are one path: the key resolves to the
    // same target a click on that row resolves.
    const store = makeStore();
    const rowId = "ses_wt_station_idle";

    expect(resolveKeyRowAgentTarget(store, slotForRow(store, rowId))).toEqual(
      resolveRowAgentTarget(store, rowId),
    );
  });

  it("does not launch outside dashboard mode (choose-slot keeps slot meaning)", () => {
    // The same slot key that opens an agent in dashboard mode must instead
    // select the row for removal here — so it defers to the machine, not launch.
    const store = makeStore();
    const slot = slotForRow(store, "ses_wt_station_idle");
    store.getState().handleKey({ input: "X" }); // enter remove choose-slot mode

    expect(resolveKeyRowAgentTarget(store, slot)).toEqual({ kind: "none" });
  });
});

function pendingStartIds(store: StoreApi<TuiStore>): string[] {
  return store.getState().localRows.pendingStart.map((row) => row.localId);
}

// The fixture's worktree path / project root, read back from a fresh snapshot
// (deterministic builder) so tests assert equivalence to the data the resolver
// reads rather than duplicating the fixture's path format.
function rowPath(rowId: string): string {
  const path = manyProjectsSnapshot().rows.find((row) => row.id === rowId)?.path;
  if (path === undefined) {
    throw new Error(`no fixture row ${rowId}`);
  }
  return path;
}

function projectRoot(projectId: string): string {
  const root = manyProjectsSnapshot().projects.find((project) => project.id === projectId)?.root;
  if (root === undefined) {
    throw new Error(`no fixture project ${projectId}`);
  }
  return root;
}

function slotForRow(store: StoreApi<TuiStore>, rowId: string): string {
  const state = store.getState();
  if (state.snapshot === undefined) {
    throw new Error("store has no snapshot");
  }
  // Mirrors the viewport selector the actions module uses; resolved through
  // the store so the slot reflects current scroll/search state.
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice === undefined) {
    throw new Error(`no slot for row ${rowId}`);
  }
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

describe("routeStationMouse widget settings", () => {
  function panelStore(): StoreApi<TuiStore> {
    const store = makeStore();
    store.setState({ widgets: [{ type: "time" }, { type: "moon" }] });
    store.getState().handleKey({ input: "W" });
    return store;
  }

  it("opens the panel from the header [+] on the dashboard only", () => {
    const store = makeStore();
    expect(routeStationMouse({ kind: "widgetSettingsOpen" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
    expect(store.getState().screen.name).toBe("widgetSettings");

    // In any other mode the click is absorbed without opening.
    const busy = makeStore();
    busy.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "widgetSettingsOpen" }, LEFT_DOWN, busy);
    expect(busy.getState().screen.name).toBe("help");
  });

  it("toggles a clicked row and moves the cursor onto it", () => {
    const store = panelStore();
    routeStationMouse({ kind: "widgetSettingsRow", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().widgets[1]).toEqual({ type: "moon", enabled: false });
    const screen = store.getState().screen;
    expect(screen.name === "widgetSettings" && screen.cursor).toBe(1);
  });

  it("removes via the row's ×", () => {
    const store = panelStore();
    routeStationMouse({ kind: "widgetSettingsRemove", index: 0 }, LEFT_DOWN, store);
    expect(store.getState().widgets.map((widget) => widget.type)).toEqual(["moon"]);
  });

  it("adds from the picker via [ + add widget ] then a choice row", () => {
    const store = panelStore();
    routeStationMouse({ kind: "widgetSettingsAdd" }, LEFT_DOWN, store);
    const picking = store.getState().screen;
    expect(picking.name === "widgetSettings" && picking.focus).toBe("picker");
    routeStationMouse({ kind: "widgetSettingsPickerChoice", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().widgets.at(-1)).toEqual({ type: "fleet" });
    const done = store.getState().screen;
    expect(done.name === "widgetSettings" && done.focus).toBe("list");
  });

  it("ignores panel targets outside the widgetSettings mode", () => {
    const store = makeStore();
    store.setState({ widgets: [{ type: "time" }] });
    routeStationMouse({ kind: "widgetSettingsRow", index: 0 }, LEFT_DOWN, store);
    expect(store.getState().widgets[0]).toEqual({ type: "time" });
  });

  it("moves the add-project cursor to a clicked row", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "A" });
    const opened = store.getState().screen;
    if (opened.name !== "addProject" || opened.flow.mode !== "start") {
      throw new Error("expected addProject start");
    }
    expect(opened.flow.selectedIndex).toBe(0);

    routeStationMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    const moved = store.getState().screen;
    if (moved.name !== "addProject" || moved.flow.mode !== "start") {
      throw new Error("expected addProject start");
    }
    expect(moved.flow.selectedIndex).toBe(1);
  });

  it("ignores an add-project row click outside addProject mode", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().screen.name).toBe("help");
  });
});
