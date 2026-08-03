// Pins the mouse router's modal guards to keyboard modality (the screen ×
// target matrix) and mouse/keyboard equivalence: a row click must produce
// exactly the state the row's slot key produces, in every mode where rows
// are interactive.
import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import type { ProviderId, StationSnapshot } from "@station/contracts";
import {
  addProjectSelectedIndex,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectSubmitted,
  persistentFilterExperience,
  selectDashboardViewport,
} from "@station/dashboard-core";
import { addTuiToast } from "@station/dashboard-core";
import {
  createEditableTextInputState,
  openProjectSettings,
  removeProjectConfirmPhrase,
} from "@station/dashboard-core";
import type { TuiStore } from "@station/dashboard-core";
import { agentWorktreePaneId } from "../../state/types.js";
import type { StationMouseEvent } from "../../input/mouse.js";
import { manyProjectsSnapshot, noProjectsSnapshot } from "../fixtures/scenarios.js";
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

const LEFT_UP: StationMouseEvent = {
  ...LEFT_DOWN,
  type: "up",
};

const MIDDLE_DOWN: StationMouseEvent = {
  ...LEFT_DOWN,
  button: "middle",
  rawButton: 1,
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

function snapshotWithUnavailableCodex(): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness",
        status: "unavailable",
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
}

function snapshotWithBareProject(projectId: string): StationSnapshot {
  const base = manyProjectsSnapshot();
  const project = base.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error(`no fixture project ${projectId}`);
  return {
    ...base,
    projects: base.projects.map((candidate) =>
      candidate.id === projectId
        ? {
            ...candidate,
            health: {
              ...candidate.health,
              status: "unavailable",
              lastError: {
                tag: "WorktreeProviderError",
                code: "WORKTRUNK_PROJECT_ROOT_BARE",
                message: "Project checkout is configured as a bare repository.",
                hint: `Inspect with git -C '${candidate.root}' config --show-origin --get core.bare. If this is the intended checkout, run git -C '${candidate.root}' config --local core.bare false; otherwise correct projects.root.`,
                provider: "worktrunk",
                projectId,
              },
            },
          }
        : candidate,
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

  it("confirms remove with the semantic Delete action", () => {
    const store = makeStore();
    const worktreeId = "wt_station_working";
    const rowId = `ses_${worktreeId}`;
    store.getState().handleKey({ input: "X" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });

    const outcome = routeStationMouse(
      { kind: "removeWorktreeAction", actionId: "confirm.delete" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().localRows.pendingRemove).toMatchObject([
      { localId: `remove:${worktreeId}`, worktreeId },
    ]);
  });

  it("cancels remove with the semantic Keep action", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_working";
    store.getState().handleKey({ input: "X" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });

    const outcome = routeStationMouse(
      { kind: "removeWorktreeAction", actionId: "confirm.keep" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().localRows.pendingRemove).toEqual([]);
  });

  it("keeps stale Remove actions inert", () => {
    const store = makeStore();
    const before = store.getState().screen;
    const target = {
      kind: "removeWorktreeAction",
      actionId: "confirm.delete",
    } as const;

    const outcome = routeStationMouse(target, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual(before);
    expect(store.getState().localRows.pendingRemove).toEqual([]);

    store.getState().handleKey({ input: "X" });
    routeStationMouse(target, LEFT_DOWN, store);
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

    const clickedScreen = clicked.getState().screen;
    const keyedScreen = keyed.getState().screen;
    if (
      clickedScreen.name !== "fork" ||
      clickedScreen.step !== "details" ||
      keyedScreen.name !== "fork" ||
      keyedScreen.step !== "details"
    ) {
      throw new Error("expected fork details from click and key paths");
    }
    const { branch: clickedBranch, ...clickedStable } = clickedScreen;
    const { branch: keyedBranch, ...keyedStable } = keyedScreen;
    expect(clickedStable).toEqual(keyedStable);
    expect(clickedBranch).toContain("-fork-");
    expect(keyedBranch).toContain("-fork-");
  });

  it("focuses Fork Name and toggles Copy through semantic field actions", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_working";
    store.getState().handleKey({ input: "F" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });
    store.getState().handleKey({ input: "", downArrow: true });
    store.getState().handleKey({ input: "", downArrow: true });

    expect(
      routeStationMouse(
        { kind: "forkSessionAction", actionId: "details.name" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({ kind: "handled" });
    expect(store.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "name",
      copyDirty: true,
    });

    routeStationMouse(
      { kind: "forkSessionAction", actionId: "details.copyDirty" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "fork",
      step: "details",
      focus: "copyDirty",
      copyDirty: false,
    });
  });

  it("launches a fork from the semantic submit action", () => {
    const store = makeStore();
    const worktreeId = "wt_station_working";
    const rowId = `ses_${worktreeId}`;
    store.getState().handleKey({ input: "F" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });
    expect(store.getState().screen).toMatchObject({ name: "fork", step: "details" });

    const outcome = routeStationMouse(
      { kind: "forkSessionAction", actionId: "details.submit" },
      LEFT_DOWN,
      store,
    );

    expect(outcome.kind).toBe("launch-fork");
    if (outcome.kind === "launch-fork") {
      expect(outcome.projectId).toBe("station");
      expect(outcome.sourceWorktreeId).toBe(worktreeId);
      expect(outcome.copyDirty).toBe(true);
      expect(outcome.title).toMatch(/-fork$/);
      expect(outcome.branch).toContain("-fork-");
      expect(outcome.title).not.toBe(outcome.branch);
    }
    // The submit is intercepted, not dispatched to the machine — the sheet stays open
    // until the executor closes it, so the machine never ran the tmux session.fork.
    expect(store.getState().screen).toMatchObject({ name: "fork", step: "details" });
  });

  it("keeps stale Fork actions inert", () => {
    const store = makeStore();
    const outcome = routeStationMouse(
      { kind: "forkSessionAction", actionId: "details.submit" },
      LEFT_DOWN,
      store,
    );
    expect(outcome).toEqual({ kind: "handled" });
  });

  it("submits Rename Session through its semantic sheet button", () => {
    const store = makeStore();
    const rowId = "ses_wt_station_idle";
    store.getState().handleKey({ input: "R" });
    store.getState().handleKey({ input: slotForRow(store, rowId) });
    store.getState().handleKey({ input: "Mouse title" });

    const outcome = routeStationMouse({ kind: "renameSessionSubmit" }, LEFT_DOWN, store);

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().localRows.pendingRenameTitles?.[rowId]?.title).toBe("Mouse title");
  });

  it("keeps a stale Rename Session button inert", () => {
    const store = makeStore();
    const before = store.getState().screen;

    expect(routeStationMouse({ kind: "renameSessionSubmit" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
    expect(store.getState().screen).toBe(before);
    expect(store.getState().localRows.pendingRenameTitles).toEqual({});
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

  it("edits and clears an applied filter from footer actions only in dashboard mode", () => {
    const fixture = makeStationTestStore({
      terminalRows: 14,
      dashboardSearchExperience: persistentFilterExperience,
    });
    const store = fixture.store;
    store.setState({ persistentFilter: { query: "working" } });

    expect(
      routeStationMouse(
        { kind: "persistentFilterAction", actionId: "persistentFilter.edit" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({ kind: "handled" });
    expect(store.getState().screen).toEqual({
      name: "persistentFilter",
      draft: { value: "working", cursor: 7 },
    });

    store.getState().handleKey({ input: "", escape: true });
    store.getState().handleKey({ input: "H" });
    routeStationMouse(
      { kind: "persistentFilterAction", actionId: "persistentFilter.clear" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toEqual({ name: "help" });
    expect(store.getState().persistentFilter).toEqual({ query: "working" });

    store.getState().handleKey({ input: "", escape: true });
    routeStationMouse(
      { kind: "persistentFilterAction", actionId: "persistentFilter.clear" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().persistentFilter).toBeUndefined();
  });

  it("toggles project collapse on header click, dashboard mode only", () => {
    const store = makeStore();

    routeStationMouse({ kind: "projectHeader", projectId: "station" }, LEFT_DOWN, store);
    expect([...store.getState().collapsedProjectIds]).toEqual(["station"]);
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "primary",
    });

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

  it("dismisses a bounded screen only on primary-down over the screen backdrop", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "H" });

    for (const event of [LEFT_UP, RIGHT_DOWN, MIDDLE_DOWN, SCROLL_DOWN]) {
      expect(routeStationMouse({ kind: "screenBackdrop" }, event, store)).toEqual({
        kind: "handled",
      });
      expect(store.getState().screen).toEqual({ name: "help" });
    }

    expect(routeStationMouse({ kind: "screenBackdrop" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
    expect(store.getState().screen).toEqual({ name: "dashboard" });
  });

  it("keeps stale screen and sheet backdrop wheel events from scrolling after dismissal", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "screenBackdrop" }, LEFT_DOWN, store);

    routeStationMouse({ kind: "screenBackdrop" }, SCROLL_DOWN, store);
    routeStationMouse({ kind: "sheetBackdrop" }, SCROLL_DOWN, store);

    expect(store.getState().screen).toEqual({ name: "dashboard" });
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

  it("treats right-click as inert at the STATION router layer", () => {
    const store = makeStore();
    const before = store.getState().screen;

    const outcome = routeStationMouse(
      { kind: "projectHeader", projectId: "station" },
      RIGHT_DOWN,
      store,
    );

    expect(outcome).toEqual({ kind: "handled" });
    expect(store.getState().screen).toBe(before);
    expect([...store.getState().collapsedProjectIds]).toEqual([]);
  });

  it("opens first-project onboarding from the dashboard CTA only while empty", () => {
    const empty = makeStore(noProjectsSnapshot());
    expect(routeStationMouse({ kind: "firstProjectAdd" }, LEFT_DOWN, empty)).toEqual({
      kind: "handled",
    });
    expect(empty.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "start", firstProject: true },
    });

    const populated = makeStore();
    routeStationMouse({ kind: "firstProjectAdd" }, LEFT_DOWN, populated);
    expect(populated.getState().screen).toEqual({ name: "dashboard" });
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
    const outcome = routeStationMouse(
      { kind: "openShellForProject", projectId: "station" },
      LEFT_DOWN,
      store,
    );
    expect(outcome).toEqual({
      kind: "open-pane",
      paneId: "pane-proj-station",
      cwd: projectRoot("station"),
      role: "shell",
    });
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "shell",
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

    expect(
      routeStationMouse(
        { kind: "openShellForRow", rowId: "ses_wt_station_idle" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({
      kind: "handled",
    });
    expect(
      routeStationMouse({ kind: "openShellForProject", projectId: "station" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
  });

  it("treats an unresolvable row or project as an inert click", () => {
    const store = makeStore();
    expect(
      routeStationMouse({ kind: "openShellForRow", rowId: "wt_nope" }, LEFT_DOWN, store),
    ).toEqual({
      kind: "handled",
    });
    expect(
      routeStationMouse({ kind: "openShellForProject", projectId: "ghost" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
  });

  it("creates a session immediately via [+] quick-session affordance", () => {
    const store = makeStore();
    const outcome = routeStationMouse(
      { kind: "quickSessionForProject", projectId: "station" },
      LEFT_DOWN,
      store,
    );
    expect(outcome.kind).toBe("launch-new-session");
    if (outcome.kind === "launch-new-session") {
      expect(outcome.projectId).toBe("station");
      expect(outcome.harness).toBe("codex"); // project.defaults.harness
      expect(outcome.branch).toMatch(/^station-[0-9a-f]+$/);
      expect(outcome.title).toBe(outcome.branch);
    }
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "quickSession",
    });
  });

  it("routes the empty-project action to the native managed launch outcome", () => {
    const store = makeStore();
    const outcome = routeStationMouse(
      { kind: "emptyProjectAction", projectId: "empty-project" },
      LEFT_DOWN,
      store,
    );

    expect(outcome).toMatchObject({
      kind: "launch-new-session",
      projectId: "empty-project",
      harness: "codex",
    });
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "empty-project",
      control: "quickSession",
    });
  });

  it("keeps blocked empty-project activation focused for retry", () => {
    const store = makeStore(snapshotWithBareProject("empty-project"));

    expect(
      routeStationMouse(
        { kind: "emptyProjectAction", projectId: "empty-project" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({ kind: "handled" });
    expect(store.getState().dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "empty-project",
    });
    expect(store.getState().toasts.at(-1)?.toast.kind).toBe("error");
  });

  it("keeps stale and modal empty-project targets inert", () => {
    const stale = makeStore();
    expect(
      routeStationMouse({ kind: "emptyProjectAction", projectId: "ghost" }, LEFT_DOWN, stale),
    ).toEqual({ kind: "handled" });
    expect(
      routeStationMouse({ kind: "emptyProjectAction", projectId: "station" }, LEFT_DOWN, stale),
    ).toEqual({ kind: "handled" });
    expect(stale.getState().dashboardFocus).toBeUndefined();

    const modal = makeStore();
    modal.getState().handleKey({ input: "H" });
    expect(
      routeStationMouse(
        { kind: "emptyProjectAction", projectId: "empty-project" },
        LEFT_DOWN,
        modal,
      ),
    ).toEqual({ kind: "handled" });
    expect(modal.getState().screen).toEqual({ name: "help" });
    expect(modal.getState().dashboardFocus).toBeUndefined();
  });

  it("shows the blocked Quick Session error without emitting a launch outcome", () => {
    const store = makeStore(snapshotWithBareProject("station"));

    expect(
      routeStationMouse({ kind: "quickSessionForProject", projectId: "station" }, LEFT_DOWN, store),
    ).toEqual({ kind: "handled" });
    expect(store.getState().localRows.pendingCreate).toEqual([]);
    const toast = store.getState().toasts.at(-1)?.toast;
    expect(toast).toMatchObject({
      kind: "error",
      message: "Project checkout is configured as a bare repository.",
    });
    expect(toast?.hint).toContain("config --local core.bare false");
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "quickSession",
    });
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
    expect(store.getState().dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "station",
      control: "defaultAgent",
    });
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
    expect(routeStationMouse({ kind: "projectSettingsConfirmRemove" }, LEFT_DOWN, store)).toEqual({
      kind: "handled",
    });
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
    expect(addProjectSelectedIndex(store.getState())).toBe(0);

    routeStationMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    const moved = store.getState().screen;
    if (moved.name !== "addProject" || moved.flow.mode !== "start") {
      throw new Error("expected addProject start");
    }
    expect(addProjectSelectedIndex(store.getState())).toBe(1);
  });

  it("routes Add Project controls through enabled shared actions", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "A" });
    routeStationMouse(
      { kind: "addProjectAction", actionId: "start.cancel" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toEqual({ name: "dashboard" });

    store.getState().handleKey({ input: "A" });
    store.setState(
      applyAddProjectFolderReviewed(store.getState(), {
        selectedPath: "/workspace/station",
        gitRoot: "/workspace/station",
        id: "station",
        label: "Station",
      }),
    );
    routeStationMouse(
      { kind: "addProjectAction", actionId: "review.editId" },
      LEFT_DOWN,
      store,
    );
    store.getState().handleKey({ input: "-mouse" });
    routeStationMouse(
      { kind: "addProjectAction", actionId: "editId.save" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "review", id: "station-mouse", actionFocus: "submit" },
    });

    const success = applyAddProjectSubmitted(store.getState(), {
      label: "Station",
      root: "/workspace/station",
    });
    store.setState(success);
    routeStationMouse(
      { kind: "addProjectAction", actionId: "success.dashboard" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toEqual({ name: "dashboard" });

    store.getState().handleKey({ input: "A" });
    store.setState(
      applyAddProjectFolderReviewFailed(
        store.getState(),
        "/workspace/station",
        new Error("review failed"),
      ),
    );
    routeStationMouse(
      { kind: "addProjectAction", actionId: "failed.cancel" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toEqual({ name: "dashboard" });
  });

  it("keeps disabled and stale Add Project controls inert", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "A" });
    store.setState(
      applyAddProjectFolderReviewed(store.getState(), {
        selectedPath: "/workspace/notes",
        id: "notes",
        label: "Notes",
      }),
    );
    routeStationMouse(
      { kind: "addProjectAction", actionId: "review.submit" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "addProject",
      flow: { mode: "review", submitting: false, actionFocus: "chooseFolder" },
    });

    routeStationMouse(
      { kind: "addProjectAction", actionId: "failed.retry" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({ name: "addProject", flow: { mode: "review" } });
  });

  it("routes Create Session review and name-editor controls", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "N" });
    routeStationMouse(
      { kind: "newSessionAction", actionId: "review.project" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "pickProject" },
    });

    store.getState().handleKey({ input: "", escape: true });
    routeStationMouse(
      { kind: "newSessionAction", actionId: "review.name" },
      LEFT_DOWN,
      store,
    );
    store.getState().handleKey({ input: "Mouse session" });
    routeStationMouse(
      { kind: "newSessionAction", actionId: "editName.save" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "review", title: "Mouse session" },
    });

    routeStationMouse(
      { kind: "newSessionAction", actionId: "review.name" },
      LEFT_DOWN,
      store,
    );
    store.getState().handleKey({ input: "", downArrow: true });
    routeStationMouse(
      { kind: "newSessionAction", actionId: "editName.name" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({
      name: "newSession",
      flow: { mode: "editName", editNameFocus: "name" },
    });
    routeStationMouse(
      { kind: "newSessionAction", actionId: "editName.back" },
      LEFT_DOWN,
      store,
    );
    expect(store.getState().screen).toMatchObject({ name: "newSession", flow: { mode: "review" } });
  });

  it("returns the native managed-launch outcome for direct Create", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "N" });
    store.getState().handleKey({ input: "", downArrow: true });

    const outcome = routeStationMouse(
      { kind: "newSessionAction", actionId: "review.create" },
      LEFT_DOWN,
      store,
    );
    expect(outcome).toMatchObject({
      kind: "launch-new-session",
      projectId: "station",
      harness: "codex",
    });
  });

  it("keeps a stale unavailable Create target inert", () => {
    const store = makeStore(snapshotWithUnavailableCodex());
    store.getState().handleKey({ input: "N" });

    expect(
      routeStationMouse(
        { kind: "newSessionAction", actionId: "review.create" },
        LEFT_DOWN,
        store,
      ),
    ).toEqual({ kind: "handled" });
    expect(store.getState().screen.name).toBe("newSession");
    expect(store.getState().toasts).toEqual([]);
  });

  it("ignores an add-project row click outside addProject mode", () => {
    const store = makeStore();
    store.getState().handleKey({ input: "H" });
    routeStationMouse({ kind: "addProjectRow", index: 1 }, LEFT_DOWN, store);
    expect(store.getState().screen.name).toBe("help");
  });
});
