import {
  applyAddProjectFolderReviewed,
  createInitialTuiState,
  type DashboardStateAction,
  focusDashboardProjectHeader,
  focusProjectSettingsItem,
  handleTuiKey,
  openAddProject,
  openProjectDefaultAgentPicker,
  openProjectSettings,
  openRemoveWorktreeConfirmForRow,
  openRenameEditForRow,
  openWidgetSettings,
  persistentFilterExperience,
  scrollDashboard,
  selectAddProjectRow,
  type TuiState,
  tuiScreenBehavior,
  widgetSettingsAddFromPicker,
  widgetSettingsOpenPicker,
  widgetSettingsRemoveAt,
  widgetSettingsToggleAt,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { handleTuiAction } from "../../../src/state/actions.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const context = {
  cwd: "/workspace",
  homeDir: "/home/example",
};

type StateActionCase = Readonly<{
  name: string;
  action: DashboardStateAction;
  state: () => TuiState;
  reduce: (state: TuiState) => TuiState;
}>;

const STATE_ACTION_CASES: readonly StateActionCase[] = [
  {
    name: "dashboard.scroll",
    action: { type: "dashboard.scroll", delta: 5 },
    state: scrollingDashboardState,
    reduce: (state) => scrollDashboard(state, 5),
  },
  {
    name: "dashboard.projectHeader.focus",
    action: {
      type: "dashboard.projectHeader.focus",
      projectId: "web",
      control: "quickSession",
    },
    state: dashboardState,
    reduce: (state) => focusDashboardProjectHeader(state, "web", "quickSession"),
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
  {
    type: "dashboard.projectHeader.focus",
    projectId: "missing",
    control: "primary",
  },
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
      handleTuiKey(state, { input: "/" }, context, persistentFilterExperience).state,
      { input: "i", ctrl: true },
      context,
      persistentFilterExperience,
    ).state;
    const fieldByKey = handleTuiKey(opened, { input: "S" }, context, persistentFilterExperience);
    const fieldByAction = handleTuiAction(
      opened,
      { type: "persistentFilter.condition.selectField", field: "status" },
      context,
    );
    expect(fieldByAction).toEqual(fieldByKey);

    const valueByKey = handleTuiKey(
      fieldByKey.state,
      { input: "3" },
      context,
      persistentFilterExperience,
    );
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

    const doneByKey = handleTuiKey(
      valueByKey.state,
      { input: "\r", return: true },
      context,
      persistentFilterExperience,
    );
    const doneByAction = handleTuiAction(
      valueByAction.state,
      { type: "persistentFilter.condition.done" },
      context,
    );
    expect(doneByAction).toEqual(doneByKey);

    const appliedByKey = handleTuiKey(
      doneByKey.state,
      { input: "F" },
      context,
      persistentFilterExperience,
    );
    const appliedByAction = handleTuiAction(
      doneByAction.state,
      { type: "persistentFilter.applyDraft" },
      context,
    );
    expect(appliedByAction).toEqual(appliedByKey);

    const backByKey = handleTuiKey(
      fieldByKey.state,
      { input: "", leftArrow: true },
      context,
      persistentFilterExperience,
    );
    const backByAction = handleTuiAction(
      fieldByAction.state,
      { type: "persistentFilter.condition.back" },
      context,
    );
    expect(backByAction).toEqual(backByKey);

    const closedByKey = handleTuiKey(
      fieldByKey.state,
      { input: "", escape: true },
      context,
      persistentFilterExperience,
    );
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
});

function dashboardState(): TuiState {
  return createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
}

function scrollingDashboardState(): TuiState {
  return { ...dashboardState(), terminalRows: 8 };
}

function projectSettingsState(): TuiState {
  return openProjectSettings(dashboardState(), "web");
}

function addProjectStartState(): TuiState {
  return openAddProject(createInitialTuiState(), context);
}

function widgetSettingsState(): TuiState {
  return openWidgetSettings({
    ...dashboardState(),
    widgets: [{ type: "time" }, { type: "moon" }],
  });
}

function clickAwayActiveScreen(state: TuiState): TuiState {
  const clickAway = tuiScreenBehavior(state.screen).clickAway;
  if (clickAway === undefined) {
    throw new Error("expected active screen click-away behavior");
  }
  return clickAway(state);
}

function addProjectReviewState(): TuiState {
  const state = openAddProject(createInitialTuiState(), context);
  return applyAddProjectFolderReviewed(state, {
    selectedPath: "/workspace/station",
    gitRoot: "/workspace/station",
    id: "station",
    label: "Station",
  });
}

function addProjectFlow(
  state: TuiState,
): Extract<TuiState["screen"], { name: "addProject" }>["flow"] & { mode: "review" } {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "review") {
    throw new Error("expected Add Project review");
  }
  return state.screen.flow;
}
