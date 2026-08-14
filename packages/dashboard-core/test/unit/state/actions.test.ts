import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
import type { DashboardStateAction } from "../../../src/state/actions.js";
import { handleTuiAction } from "../../../src/state/actions.js";
import { scrollDashboard } from "../../../src/state/dashboardScroll.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { tuiScreenBehavior } from "../../../src/state/screenBehavior.js";
import {
  applyAddProjectFolderReviewed,
  openAddProject,
  selectAddProjectRow,
} from "../../../src/state/screens/addProjectScreen.js";
import { openGroupSettings } from "../../../src/state/screens/groupSettings.js";
import { openProjectDefaultAgentPicker } from "../../../src/state/screens/projectDefaultAgent.js";
import {
  focusProjectSettingsItem,
  openProjectSettings,
} from "../../../src/state/screens/projectSettings.js";
import { openRemoveWorktreeConfirmForRow } from "../../../src/state/screens/removeWorktree.js";
import { openRenameEditForRow } from "../../../src/state/screens/sessionRows.js";
import {
  openWidgetSettings,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
} from "../../../src/state/screens/widgetSettings.js";
import { handleTuiKey } from "../../../src/state/transition.js";
import type { DashboardState } from "../../../src/state/types.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../fixtures/snapshots.js";

const context = {
  cwd: "/workspace",
  homeDir: "/home/example",
};

type StateActionCase = Readonly<{
  name: string;
  action: DashboardStateAction;
  state: () => DashboardState;
  reduce: (state: DashboardState) => DashboardState;
}>;

const STATE_ACTION_CASES: readonly StateActionCase[] = [
  {
    name: "dashboard.scroll",
    action: { type: "dashboard.scroll", delta: 5 },
    state: scrollingDashboardState,
    reduce: (state) => scrollDashboard(state, 5),
  },
  {
    name: "projectSettings.focusItem",
    action: { type: "projectSettings.focusItem", itemId: "remove" },
    state: projectSettingsState,
    reduce: (state) => focusProjectSettingsItem(state, "remove"),
  },
  {
    name: "addProject.selectRow",
    action: { type: "addProject.selectRow", index: 1 },
    state: addProjectStartState,
    reduce: (state) => selectAddProjectRow(state, 1),
  },
  {
    name: "screen.clickAway",
    action: { type: "screen.clickAway" },
    state: widgetSettingsState,
    reduce: clickAwayActiveScreen,
  },
  {
    name: "renameSession.openEdit",
    action: {
      type: "renameSession.openEdit",
      rowId: "ses_wt_web_idle",
      returnTo: "dashboard",
    },
    state: dashboardState,
    reduce: (state) => openRenameEditForRow(state, "ses_wt_web_idle", { returnTo: "dashboard" }),
  },
  {
    name: "removeWorktree.openConfirm",
    action: { type: "removeWorktree.openConfirm", rowId: "ses_wt_web_idle" },
    state: dashboardState,
    reduce: (state) => openRemoveWorktreeConfirmForRow(state, "ses_wt_web_idle"),
  },
  {
    name: "projectDefaultAgent.open",
    action: { type: "projectDefaultAgent.open", projectId: "web" },
    state: dashboardState,
    reduce: (state) => openProjectDefaultAgentPicker(state, "web"),
  },
  {
    name: "projectSettings.open",
    action: { type: "projectSettings.open", projectId: "web" },
    state: dashboardState,
    reduce: (state) => openProjectSettings(state, "web"),
  },
  {
    name: "groupSettings.open",
    action: { type: "groupSettings.open", groupId: "group_active", section: "remove" },
    state: groupedDashboardState,
    reduce: (state) => openGroupSettings(state, "group_active", "remove"),
  },
  {
    name: "widgetSettings.open",
    action: { type: "widgetSettings.open" },
    state: dashboardState,
    reduce: openWidgetSettings,
  },
  {
    name: "widgetSettings.toggle",
    action: { type: "widgetSettings.toggle", index: 1 },
    state: widgetSettingsState,
    reduce: (state) => widgetSettingsToggleAt(state, 1),
  },
  {
    name: "widgetSettings.remove",
    action: { type: "widgetSettings.remove", index: 0 },
    state: widgetSettingsState,
    reduce: (state) => widgetSettingsRemoveAt(state, 0),
  },
  {
    name: "widgetSettings.openPicker",
    action: { type: "widgetSettings.openPicker" },
    state: widgetSettingsState,
    reduce: widgetSettingsOpenPicker,
  },
  {
    name: "widgetSettings.addFromPicker",
    action: { type: "widgetSettings.addFromPicker", index: 2 },
    state: widgetSettingsState,
    reduce: (state) => widgetSettingsAddFromPicker(state, 2),
  },
];

const STALE_STATE_ACTIONS: readonly DashboardStateAction[] = [
  { type: "projectSettings.focusItem", itemId: "agent" },
  { type: "addProject.selectRow", index: 0 },
  { type: "screen.clickAway" },
  {
    type: "renameSession.openEdit",
    rowId: "missing",
    returnTo: "dashboard",
  },
  { type: "removeWorktree.openConfirm", rowId: "missing" },
  { type: "projectDefaultAgent.open", projectId: "missing" },
  { type: "projectSettings.open", projectId: "missing" },
  { type: "groupSettings.open", groupId: "missing", section: "general" },
  {
    type: "forkSession.openDetails",
    rowId: "missing",
    returnTo: "dashboard",
  },
  { type: "widgetSettings.toggle", index: 0 },
  { type: "widgetSettings.remove", index: 0 },
  { type: "widgetSettings.openPicker" },
  { type: "widgetSettings.addFromPicker", index: 0 },
];

describe("semantic TUI actions", () => {
  it("opens first-project onboarding equivalently from A, focused Enter, and semantic activation", () => {
    const snapshot = {
      ...createDashboardSnapshot(),
      projects: [],
      rows: [],
      sessions: [],
    };
    const state = createInitialTuiState({ initialSnapshot: snapshot });

    const direct = handleTuiKey(state, { input: "A" }, context);
    const focused = handleTuiKey(state, { input: "\r", return: true }, context);
    const semantic = handleTuiAction(state, { type: "dashboard.addProject" }, context);

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });

  it("keeps a stale first-project semantic target inert after projects populate", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });

    expect(handleTuiAction(state, { type: "dashboard.addProject" }, context).state).toBe(state);
  });

  it("routes persistent-filter edit and clear through semantic dashboard actions", () => {
    const applied = createInitialTuiState({
      initialSnapshot: createDashboardSnapshot(),
      persistentFilter: { query: "working" },
    });

    const edited = handleTuiAction(applied, { type: "persistentFilter.edit" }, context).state;
    expect(edited.screen).toEqual({
      name: "persistentFilter",
      draft: { value: "working", cursor: 7 },
      draftConditions: [],
    });

    const cleared = handleTuiAction(applied, { type: "persistentFilter.clear" }, context).state;
    expect(cleared.screen).toEqual({ name: "dashboard" });
    expect(cleared.persistentFilter).toBeUndefined();
  });

  it("routes condition pointer intents through the same field and value transitions as keys", () => {
    const state = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const opened = handleTuiKey(
      handleTuiKey(state, { input: "/" }, context).state,
      { input: "i", ctrl: true },
      context,
    ).state;
    const fieldByKey = handleTuiKey(opened, { input: "S" }, context);
    const fieldByAction = handleTuiAction(
      opened,
      { type: "persistentFilter.condition.selectField", field: "status" },
      context,
    );
    expect(fieldByAction).toEqual(fieldByKey);

    const valueByKey = handleTuiKey(fieldByKey.state, { input: "3" }, context);
    const valueByAction = handleTuiAction(
      fieldByAction.state,
      {
        type: "persistentFilter.condition.toggleValue",
        field: "status",
        valueId: "working",
      },
      context,
    );
    expect(valueByAction).toEqual(valueByKey);

    const doneByKey = handleTuiKey(valueByKey.state, { input: "\r", return: true }, context);
    const doneByAction = handleTuiAction(
      valueByAction.state,
      { type: "persistentFilter.condition.done" },
      context,
    );
    expect(doneByAction).toEqual(doneByKey);

    const appliedByKey = handleTuiKey(doneByKey.state, { input: "F" }, context);
    const appliedByAction = handleTuiAction(
      doneByAction.state,
      { type: "persistentFilter.applyDraft" },
      context,
    );
    expect(appliedByAction).toEqual(appliedByKey);

    const backByKey = handleTuiKey(fieldByKey.state, { input: "", leftArrow: true }, context);
    const backByAction = handleTuiAction(
      fieldByAction.state,
      { type: "persistentFilter.condition.back" },
      context,
    );
    expect(backByAction).toEqual(backByKey);

    const closedByKey = handleTuiKey(fieldByKey.state, { input: "", escape: true }, context);
    const closedByAction = handleTuiAction(
      fieldByAction.state,
      { type: "persistentFilter.condition.close" },
      context,
    );
    expect(closedByAction).toEqual(closedByKey);
  });

  it("activates Add Project review controls identically through hotkey, focused Enter, and action", () => {
    const state = addProjectReviewState();

    const direct = handleTuiKey(state, { input: "N" }, context);
    const focused = handleTuiKey(
      {
        ...state,
        screen: {
          name: "addProject",
          flow: { ...addProjectFlow(state), actionFocus: "editId" },
        },
      },
      { input: "\r", return: true },
      context,
    );
    const semantic = handleTuiAction(
      state,
      { type: "addProject.activate", actionId: "review.editId" },
      context,
    );

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });

  it("activates Create Session fields identically through hotkey, focused Enter, and action", () => {
    const state = handleTuiKey(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      { input: "N" },
      context,
    ).state;
    if (state.screen.name !== "newSession" || state.screen.flow.mode !== "review") {
      throw new Error("expected new-session review");
    }

    const direct = handleTuiKey(state, { input: "P" }, context);
    const focused = handleTuiKey(
      {
        ...state,
        screen: {
          name: "newSession",
          flow: { ...state.screen.flow, reviewFocus: "project" },
        },
      },
      { input: "\r", return: true },
      context,
    );
    const semantic = handleTuiAction(
      state,
      { type: "newSession.activate", actionId: "review.project" },
      context,
    );

    expect(focused).toEqual(direct);
    expect(semantic).toEqual(direct);
  });
});

describe("dashboard state actions", () => {
  it.each(STATE_ACTION_CASES)("maps $name to its pure reducer without effects", ({
    action,
    state,
    reduce,
  }) => {
    const initial = state();
    const transition = handleTuiAction(initial, action, context);

    expect(transition).toEqual({ state: reduce(initial) });
    expect(transition.state).not.toBe(initial);
  });

  it("opens Fork details with an explicit dashboard return target and no effects", () => {
    const state = dashboardState();
    const transition = handleTuiAction(
      state,
      {
        type: "forkSession.openDetails",
        rowId: "ses_wt_web_idle",
        returnTo: "dashboard",
      },
      context,
    );

    expect(transition).toEqual({ state: transition.state });
    expect(transition.state.screen).toMatchObject({
      name: "fork",
      step: "details",
      sourceWorktreeId: "wt_web_idle",
      returnTo: "dashboard",
    });
  });

  it.each(STALE_STATE_ACTIONS)("keeps stale $type targets inert", (action) => {
    const state = createInitialTuiState();

    expect(handleTuiAction(state, action, context)).toEqual({ state });
  });

  it("keeps invalid widget rows inert", () => {
    const state = widgetSettingsState();

    expect(handleTuiAction(state, { type: "widgetSettings.toggle", index: 99 }, context)).toEqual({
      state,
    });
    expect(
      handleTuiAction(state, { type: "widgetSettings.addFromPicker", index: 99 }, context),
    ).toEqual({ state });
  });

  it("toggles Group identity, submits Group Quick Session, and keeps the menu inert", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
    const rowId = dashboardRowIds.group("group_active");
    const collapsed = handleTuiAction(
      state,
      { type: "dashboard.cell.activate", rowId, cellId: "identity" },
      context,
    );

    expect(collapsed.state.collapsedGroupIds.has("group_active")).toBe(true);
    expect(collapsed.state.dashboardFocus).toEqual({ rowId, cellId: "identity" });

    const quick = handleTuiAction(
      state,
      { type: "dashboard.cell.activate", rowId, cellId: "quickSession" },
      context,
    );
    expect(quick.operations).toEqual([
      expect.objectContaining({
        type: "quickCreateSessionInGroup",
        groupId: "group_active",
        project: expect.objectContaining({ id: "web" }),
        fallbackCell: "quickSession",
      }),
    ]);
    expect(quick.state.dashboardFocus).toEqual({ rowId, cellId: "quickSession" });
    expect(quick.state.collapsedGroupIds.size).toBe(0);

    const menu = handleTuiAction(
      state,
      { type: "dashboard.cell.activate", rowId, cellId: "menu" },
      context,
    );
    expect(menu.operations).toBeUndefined();
    expect(menu.state.dashboardFocus).toEqual({ rowId, cellId: "menu" });
    expect(menu.state.collapsedGroupIds.size).toBe(0);
  });

  it("routes Project-menu and Create Group actions through the shared semantic surface", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
    const menu = handleTuiAction(
      state,
      {
        type: "dashboard.cell.activate",
        rowId: dashboardRowIds.project("web"),
        cellId: "menu",
      },
      context,
    ).state;
    const quick = handleTuiAction(
      menu,
      { type: "projectMenu.activate", actionId: "quickGroup" },
      context,
    );
    const sheet = handleTuiAction(
      menu,
      { type: "createGroup.open", projectId: "web", returnTo: "projectHeader" },
      context,
    ).state;
    const toggled = handleTuiAction(
      sheet,
      { type: "createGroup.activate", actionId: "quickSession" },
      context,
    ).state;

    expect(menu.screen).toEqual({ name: "projectMenu", projectId: "web", focus: "quickGroup" });
    expect(quick.operations).toEqual([
      expect.objectContaining({ type: "createSessionGroup", projectId: "web", quickSession: true }),
    ]);
    expect(sheet.screen).toMatchObject({
      name: "createGroup",
      projectId: "web",
      returnTo: "projectHeader",
      quickSession: false,
    });
    expect(toggled.screen).toMatchObject({
      name: "createGroup",
      focus: "quickSession",
      quickSession: true,
    });
  });

  it("keeps stale, hidden, filtered, and wrong-cell dashboard targets inert", () => {
    const state = dashboardState();
    const stale = {
      type: "dashboard.cell.activate" as const,
      rowId: dashboardRowIds.session("missing"),
      cellId: "identity" as const,
    };
    expect(handleTuiAction(state, stale, context)).toEqual({ state });
    expect(
      handleTuiAction(
        state,
        {
          type: "dashboard.cell.activate",
          rowId: dashboardRowIds.project("web"),
          cellId: "addSession",
        },
        context,
      ),
    ).toEqual({ state });

    const hidden = {
      ...state,
      collapsedProjectIds: new Set(["web"]),
    };
    expect(
      handleTuiAction(
        hidden,
        {
          type: "dashboard.cell.activate",
          rowId: dashboardRowIds.session("ses_wt_web_idle"),
          cellId: "identity",
        },
        context,
      ),
    ).toEqual({ state: hidden });

    const hiddenGroup = createInitialTuiState({
      initialSnapshot: createGroupedDashboardSnapshot(),
      collapsedProjectIds: ["web"],
    });
    expect(
      handleTuiAction(
        hiddenGroup,
        {
          type: "dashboard.cell.activate",
          rowId: dashboardRowIds.group("group_active"),
          cellId: "menu",
        },
        context,
      ),
    ).toEqual({ state: hiddenGroup });

    const suppressedGroupActions = createInitialTuiState({
      initialSnapshot: createGroupedDashboardSnapshot(),
      groupHeaderActionVisibility: { quickSession: false, menu: false },
    });
    for (const cellId of ["quickSession", "menu"] as const) {
      expect(
        handleTuiAction(
          suppressedGroupActions,
          {
            type: "dashboard.cell.activate",
            rowId: dashboardRowIds.group("group_active"),
            cellId,
          },
          context,
        ),
      ).toEqual({ state: suppressedGroupActions });
    }

    const filtered = { ...state, persistentFilter: { query: "api" } };
    expect(
      handleTuiAction(
        filtered,
        {
          type: "dashboard.cell.activate",
          rowId: dashboardRowIds.session("ses_wt_web_idle"),
          cellId: "identity",
        },
        context,
      ),
    ).toEqual({ state: filtered });
  });
});

function dashboardState(): DashboardState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function groupedDashboardState(): DashboardState {
  return createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });
}

function scrollingDashboardState(): DashboardState {
  return { ...dashboardState(), terminalRows: 8 };
}

function projectSettingsState(): DashboardState {
  return openProjectSettings(dashboardState(), "web");
}

function addProjectStartState(): DashboardState {
  return openAddProject(createInitialTuiState(), context);
}

function widgetSettingsState(): DashboardState {
  return openWidgetSettings({
    ...dashboardState(),
    widgets: [{ type: "time" }, { type: "moon" }],
  });
}

function clickAwayActiveScreen(state: DashboardState): DashboardState {
  const clickAway = tuiScreenBehavior(state.screen).clickAway;
  if (clickAway === undefined) {
    throw new Error("expected active screen click-away behavior");
  }
  return clickAway(state);
}

function addProjectReviewState(): DashboardState {
  const state = openAddProject(createInitialTuiState(), context);
  return applyAddProjectFolderReviewed(state, {
    selectedPath: "/workspace/station",
    gitRoot: "/workspace/station",
    id: "station",
    label: "Station",
  });
}

function addProjectFlow(
  state: DashboardState,
): Extract<DashboardState["screen"], { name: "addProject" }>["flow"] & { mode: "review" } {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "review") {
    throw new Error("expected Add Project review");
  }
  return state.screen.flow;
}
