import { describe, expect, it } from "vitest";
import { createEditableTextInputState } from "../../../src/components/EditableTextInput/editing.js";
import { createAddProjectFlow } from "../../../src/flows/addProject/flow.js";
import {
  chooseStateForLoadedFolder,
  failedStateForError,
  reviewStateForFolder,
  successStateForProject,
} from "../../../src/flows/addProject/state.js";
import type { AddProjectFlowState } from "../../../src/flows/addProject/types.js";
import type { NewSessionFlowState } from "../../../src/flows/newSession.js";
import { createNewSessionFlow, transitionNewSessionFlow } from "../../../src/flows/newSession.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { tuiScreenBehavior } from "../../../src/state/screenBehavior.js";
import type { DashboardState, TuiScreen } from "../../../src/state/types.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

const snapshot = createDashboardSnapshot();
const addStart = createAddProjectFlow({
  cwd: "/Users/example/Developer/station",
  homeDir: "/Users/example",
});
const addChoose = chooseStateForLoadedFolder(addStart, "/Users/example/Developer", []);
const addReview = reviewStateForFolder(addChoose, {
  selectedPath: "/Users/example/Developer/station",
  gitRoot: "/Users/example/Developer/station",
  id: "station",
  label: "Station",
});
const addSuccess = successStateForProject(addReview, "Station", "/Users/example/Developer/station");
const addFailed = failedStateForError(addReview, addReview.selectedPath, {
  tag: "CommandValidationError",
  code: "TEST_ADD_PROJECT_FAILED",
  message: "Project review failed.",
});
const newReview = requiredNewSessionFlow();
const newEdit = requiredNewSessionEdit(newReview);
const newPickProject = requiredNewSessionTransition(newReview, { type: "pickProject" });
const newPickAgent = requiredNewSessionTransition(newReview, { type: "pickAgent" });

const renameEdit: Extract<TuiScreen, { name: "renameSession"; step: "editName" }> = {
  name: "renameSession",
  step: "editName",
  rowId: "ses_wt_web_idle",
  sessionId: "ses_wt_web_idle",
  currentTitle: "Current",
  draftTitle: createEditableTextInputState("Draft"),
};
const forkDetails: Extract<TuiScreen, { name: "fork"; step: "details" }> = {
  name: "fork",
  step: "details",
  sourceSessionId: "ses_wt_web_idle",
  sourceWorktreeId: "wt_web_idle",
  projectId: "web",
  projectLabel: "Web",
  sourceBranch: "main",
  sourceDirty: false,
  sourceAgentRunning: false,
  branch: "main-fork-abcdef",
  draftTitle: createEditableTextInputState("main-fork"),
  inheritSourceGroup: true,
  copyDirty: true,
  focus: "name",
};

const screenBehaviorCases: readonly [
  label: string,
  screen: TuiScreen,
  expected: "present" | "absent",
][] = [
  ["dashboard", { name: "dashboard" }, "absent"],
  [
    "persistent filter",
    {
      name: "persistentFilter",
      draft: createEditableTextInputState("api"),
      draftConditions: [],
    },
    "absent",
  ],
  [
    "persistent filter condition panel",
    {
      name: "persistentFilter",
      draft: createEditableTextInputState("api"),
      draftConditions: [],
      conditionEditor: { stage: "field", focusedItemId: "status" },
    },
    "present",
  ],
  ["help", { name: "help" }, "present"],
  ["project menu", { name: "projectMenu", projectId: "web", focus: "quickGroup" }, "present"],
  [
    "Group menu",
    {
      name: "groupMenu",
      projectId: "web",
      groupId: "group_active",
      focus: "quickSession",
    },
    "present",
  ],
  [
    "create group",
    {
      name: "createGroup",
      projectId: "web",
      draftName: createEditableTextInputState("Launches"),
      quickSession: false,
      focus: "name",
      submitting: false,
      returnTo: "projectMenu",
    },
    "present",
  ],
  ["project collapse picker", { name: "projectCollapse" }, "present"],
  ["project settings picker", { name: "projectSettingsPicker" }, "present"],
  ["project default-agent picker", { name: "projectDefaultAgent", projectId: "web" }, "present"],
  ["remove choose-row", { name: "removeWorktree", step: "chooseSlot" }, "absent"],
  ["remove unavailable", { name: "removeWorktree", step: "unavailable" }, "present"],
  [
    "remove confirmation",
    {
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_web_idle",
      forceRequired: false,
      label: "web",
      actionFocus: "keep",
    },
    "present",
  ],
  ["rename choose-row", { name: "renameSession", step: "chooseSlot" }, "absent"],
  ["rename details", renameEdit, "present"],
  ["fork choose-row", { name: "fork", step: "chooseSlot" }, "absent"],
  ["fork details", forkDetails, "present"],
  ["add project start", { name: "addProject", flow: addStart }, "present"],
  ["add project choose", { name: "addProject", flow: addChoose }, "present"],
  ["add project review", { name: "addProject", flow: addReview }, "present"],
  ["add project success", { name: "addProject", flow: addSuccess }, "present"],
  ["add project failed", { name: "addProject", flow: addFailed }, "present"],
  ["new session review", { name: "newSession", flow: newReview }, "present"],
  ["new session name editor", { name: "newSession", flow: newEdit }, "present"],
  ["new session project picker", { name: "newSession", flow: newPickProject }, "present"],
  ["new session agent picker", { name: "newSession", flow: newPickAgent }, "present"],
  [
    "project settings list",
    {
      name: "projectSettings",
      projectId: "web",
      focus: "list",
      activeId: "agent",
      removeDraft: createEditableTextInputState(),
    },
    "present",
  ],
  [
    "project settings detail",
    {
      name: "projectSettings",
      projectId: "web",
      focus: "detail",
      activeId: "remove",
      removeDraft: createEditableTextInputState("delete web"),
    },
    "present",
  ],
  [
    "Group settings",
    {
      name: "groupSettings",
      projectId: "web",
      groupId: "group_active",
      section: "general",
      focus: "list",
      detailFocus: "name",
      expectedVersion: 1,
      baselineName: "Active",
      nameDraft: createEditableTextInputState("Active"),
      baselineAssignments: new Map(),
      desiredSessionIds: new Set(),
      removeDraft: createEditableTextInputState(),
    },
    "present",
  ],
  [
    "widget settings list",
    {
      name: "widgetSettings",
      focus: "list",
      widgetItemIds: ["widget:0"],
      activeWidgetItemId: "widget:0",
      activePickerType: "time",
      nextWidgetIdentity: 1,
    },
    "present",
  ],
  [
    "widget add picker",
    {
      name: "widgetSettings",
      focus: "picker",
      widgetItemIds: ["widget:0"],
      activeWidgetItemId: "widget:0",
      activePickerType: "fleet",
      nextWidgetIdentity: 1,
    },
    "present",
  ],
];

describe("TUI screen behavior", () => {
  it.each(screenBehaviorCases)("resolves click-away for %s", (_label, screen, expected) => {
    const presence = tuiScreenBehavior(screen).clickAway === undefined ? "absent" : "present";
    expect(presence).toBe(expected);
  });

  it("declares dashboard hover separately from click-away behavior", () => {
    const persistentFilter = tuiScreenBehavior({
      name: "persistentFilter",
      draft: createEditableTextInputState("api"),
      draftConditions: [],
    });
    const newSession = tuiScreenBehavior({ name: "newSession", flow: newReview });

    expect(tuiScreenBehavior({ name: "dashboard" }).dashboardHoverEnabled).toBe(true);
    expect(persistentFilter.dashboardHoverEnabled).toBe(false);
    expect(persistentFilter.clickAway).toBeUndefined();
    expect(newSession.dashboardHoverEnabled).toBe(false);
    expect(newSession.clickAway).toBeTypeOf("function");
    expect(
      tuiScreenBehavior({ name: "removeWorktree", step: "chooseSlot" }).dashboardHoverEnabled,
    ).toBe(true);
  });

  it("click-away closes only the condition panel and preserves the filter draft", () => {
    const state = withScreen({
      name: "persistentFilter",
      draft: createEditableTextInputState("api"),
      draftConditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
      conditionEditor: {
        stage: "values",
        field: "status",
        cursor: 2,
        options: [{ id: "working", label: "Working" }],
        selectedIds: [],
      },
    });

    expect(clickAway(state).screen).toEqual({
      name: "persistentFilter",
      draft: createEditableTextInputState("api"),
      draftConditions: [{ field: "status", values: [{ id: "working", label: "Working" }] }],
    });
  });

  it("returns Project surfaces to their invocation focus and keeps a pending sheet inert", () => {
    const menu = withScreen({ name: "projectMenu", projectId: "web", focus: "settings" });
    const groupMenu = withScreen({
      name: "groupMenu",
      projectId: "web",
      groupId: "group_active",
      focus: "remove",
    });
    const createGroup = withScreen({
      name: "createGroup",
      projectId: "web",
      draftName: createEditableTextInputState("Launches"),
      quickSession: true,
      focus: "create",
      submitting: false,
      returnTo: "projectMenu",
    });

    expect(clickAway(menu)).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: "project:web", cellId: "menu" },
    });
    expect(clickAway(groupMenu)).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: "group:group_active", cellId: "menu" },
    });
    expect(clickAway(createGroup).screen).toEqual({
      name: "projectMenu",
      projectId: "web",
      focus: "newGroup",
    });
    if (createGroup.screen.name !== "createGroup") throw new Error("Create Group screen missing.");
    const pending = {
      ...createGroup,
      screen: { ...createGroup.screen, submitting: true },
    };
    expect(clickAway(pending)).toBe(pending);
  });

  it("backs nested New Session steps to review and discards the nested draft", () => {
    const edited: NewSessionFlowState = {
      ...newEdit,
      draftName: createEditableTextInputState("discard me"),
    };

    const dismissed = clickAway(withScreen({ name: "newSession", flow: edited }));

    expect(dismissed.screen).toEqual({
      name: "newSession",
      flow: { ...newReview, reviewFocus: "create" },
    });
    expect(clickAway(withScreen({ name: "newSession", flow: newPickProject })).screen).toEqual({
      name: "newSession",
      flow: { ...newReview, reviewFocus: "create" },
    });
    expect(clickAway(withScreen({ name: "newSession", flow: newPickAgent })).screen).toEqual({
      name: "newSession",
      flow: { ...newReview, reviewFocus: "create" },
    });
    expect(clickAway(withScreen({ name: "newSession", flow: newReview })).screen).toEqual({
      name: "dashboard",
    });
  });

  it("cancels the topmost Add Project editor or filter before closing the flow", () => {
    const editing: AddProjectFlowState = {
      ...addReview,
      editingId: createEditableTextInputState("discard-me"),
    };
    const editorCancelled = clickAway(withScreen({ name: "addProject", flow: editing }));
    expect(editorCancelled.screen).toEqual({ name: "addProject", flow: addReview });
    expect(clickAway(editorCancelled).screen).toEqual({ name: "dashboard" });

    const filtering: AddProjectFlowState = {
      ...addChoose,
      filter: "station",
      filterMode: true,
      searchEntries: [{ name: "station", path: "/tmp/station", kind: "directory" }],
      searching: true,
      searchTruncated: true,
    };
    const filterCleared = clickAway({
      ...withScreen({ name: "addProject", flow: filtering }),
      selection: new Map([["addProjectChoose", "/tmp/station"]]),
    });
    expect(filterCleared.screen).toMatchObject({
      name: "addProject",
      flow: {
        mode: "choose",
        filter: "",
        filterMode: false,
        searchEntries: [],
        searching: false,
        searchTruncated: false,
      },
    });
    expect(filterCleared.selection.get("addProjectChoose")).toBe(addChoose.currentPath);
    expect(clickAway(filterCleared).screen).toEqual({ name: "dashboard" });
  });

  it("closes ordinary Add Project states", () => {
    for (const flow of [addStart, addChoose, addReview, addSuccess, addFailed]) {
      expect(clickAway(withScreen({ name: "addProject", flow })).screen).toEqual({
        name: "dashboard",
      });
    }
  });

  it("closes Project Settings from either pane and discards the remove phrase", () => {
    for (const focus of ["list", "detail"] as const) {
      const state = withScreen({
        name: "projectSettings",
        projectId: "web",
        focus,
        activeId: "remove",
        removeDraft: createEditableTextInputState("delete web"),
      });

      expect(clickAway(state).screen).toEqual({ name: "dashboard" });
    }
  });

  it("cancels remove information and confirmation without adding effects", () => {
    for (const screen of screenBehaviorCases
      .map(([, screen]) => screen)
      .filter(
        (screen): screen is Extract<TuiScreen, { name: "removeWorktree" }> =>
          screen.name === "removeWorktree" && screen.step !== "chooseSlot",
      )) {
      const dismissed = clickAway(withScreen(screen));
      expect(dismissed.screen).toEqual({ name: "dashboard" });
      expect("commands" in dismissed).toBe(false);
      expect("operations" in dismissed).toBe(false);
    }
  });

  it("preserves applied widget changes while backing out of picker and panel", () => {
    const state: DashboardState = {
      ...withScreen({
        name: "widgetSettings",
        focus: "picker",
        widgetItemIds: ["widget:0", "widget:1"],
        activeWidgetItemId: "widget:1",
        activePickerType: "prs",
        nextWidgetIdentity: 2,
      }),
      widgets: [{ type: "time", enabled: false }, { type: "moon" }],
    };

    const pickerDismissed = clickAway(state);
    expect(pickerDismissed.screen).toEqual({
      name: "widgetSettings",
      focus: "list",
      widgetItemIds: ["widget:0", "widget:1"],
      activeWidgetItemId: "widget:1",
      activePickerType: "prs",
      nextWidgetIdentity: 2,
    });
    expect(pickerDismissed.widgets).toBe(state.widgets);
    const panelDismissed = clickAway(pickerDismissed);
    expect(panelDismissed.screen).toEqual({ name: "dashboard" });
    expect(panelDismissed.widgets).toBe(state.widgets);
  });

  it("follows rename and fork returnTo contracts while row-choice modes pass through", () => {
    expect(clickAway(withScreen(renameEdit)).screen).toEqual({
      name: "renameSession",
      step: "chooseSlot",
    });
    expect(clickAway(withScreen({ ...renameEdit, returnTo: "dashboard" })).screen).toEqual({
      name: "dashboard",
    });
    expect(clickAway(withScreen(forkDetails)).screen).toEqual({
      name: "fork",
      step: "chooseSlot",
    });
    expect(clickAway(withScreen({ ...forkDetails, returnTo: "dashboard" })).screen).toEqual({
      name: "dashboard",
    });

    for (const screen of [
      { name: "removeWorktree", step: "chooseSlot" },
      { name: "renameSession", step: "chooseSlot" },
      { name: "fork", step: "chooseSlot" },
      {
        name: "persistentFilter",
        draft: createEditableTextInputState("api"),
        draftConditions: [],
      },
      { name: "dashboard" },
    ] satisfies TuiScreen[]) {
      const state = withScreen(screen);
      expect(clickAway(state)).toBe(state);
    }
  });
});

function withScreen(screen: TuiScreen): DashboardState {
  return { ...createInitialTuiState({ initialSnapshot: snapshot }), screen };
}

function clickAway(state: DashboardState): DashboardState {
  const handler = tuiScreenBehavior(state.screen).clickAway;
  return handler === undefined ? state : handler(state);
}

function requiredNewSessionFlow(): Extract<NewSessionFlowState, { mode: "review" }> {
  const flow = createNewSessionFlow(snapshot, "abcdef", { projectId: "web" });
  if (flow === undefined) {
    throw new Error("Expected the dashboard fixture to support New Session.");
  }
  return flow;
}

function requiredNewSessionEdit(
  flow: NewSessionFlowState,
): Extract<NewSessionFlowState, { mode: "editName" }> {
  const transitioned = transitionNewSessionFlow(flow, { type: "editName" });
  if (transitioned?.mode !== "editName") {
    throw new Error("Expected the New Session name editor.");
  }
  return transitioned;
}

function requiredNewSessionTransition(
  flow: NewSessionFlowState,
  action: Parameters<typeof transitionNewSessionFlow>[1],
): NewSessionFlowState {
  const transitioned = transitionNewSessionFlow(flow, action);
  if (transitioned === undefined) {
    throw new Error("Expected a nested New Session transition.");
  }
  return transitioned;
}
