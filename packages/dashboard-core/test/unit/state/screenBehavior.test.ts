import {
  type AddProjectFlowState,
  chooseStateForLoadedFolder,
  createAddProjectFlow,
  createEditableTextInputState,
  createInitialTuiState,
  createNewSessionFlow,
  failedStateForError,
  type NewSessionFlowState,
  reviewStateForFolder,
  successStateForProject,
  type TuiScreen,
  type TuiState,
  transitionNewSessionFlow,
  tuiScreenBehavior,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
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
  sourceWorktreeId: "wt_web_idle",
  projectId: "web",
  projectLabel: "Web",
  sourceBranch: "main",
  sourceDirty: false,
  sourceAgentRunning: false,
  branch: "main-fork-abcdef",
  draftTitle: createEditableTextInputState("main-fork"),
  copyDirty: true,
  focus: "name",
};

const screenBehaviorCases: readonly [
  label: string,
  screen: TuiScreen,
  expected: "present" | "absent",
][] = [
  ["dashboard", { name: "dashboard" }, "absent"],
  ["search", { name: "search", value: "api" }, "absent"],
  ["help", { name: "help" }, "present"],
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
    "widget settings list",
    { name: "widgetSettings", focus: "list", cursor: 0, pickerCursor: 0 },
    "present",
  ],
  [
    "widget add picker",
    { name: "widgetSettings", focus: "picker", cursor: 0, pickerCursor: 1 },
    "present",
  ],
];

describe("TUI screen behavior", () => {
  it.each(screenBehaviorCases)("resolves click-away for %s", (_label, screen, expected) => {
    const presence = tuiScreenBehavior(screen).clickAway === undefined ? "absent" : "present";
    expect(presence).toBe(expected);
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
    const state: TuiState = {
      ...withScreen({ name: "widgetSettings", focus: "picker", cursor: 1, pickerCursor: 2 }),
      widgets: [{ type: "time", enabled: false }, { type: "moon" }],
    };

    const pickerDismissed = clickAway(state);
    expect(pickerDismissed.screen).toEqual({
      name: "widgetSettings",
      focus: "list",
      cursor: 1,
      pickerCursor: 2,
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
      { name: "search", value: "api" },
      { name: "dashboard" },
    ] satisfies TuiScreen[]) {
      const state = withScreen(screen);
      expect(clickAway(state)).toBe(state);
    }
  });
});

function withScreen(screen: TuiScreen): TuiState {
  return { ...createInitialTuiState({ initialSnapshot: snapshot }), screen };
}

function clickAway(state: TuiState): TuiState {
  const handler = tuiScreenBehavior(state.screen).clickAway;
  return handler === undefined ? state : handler(state);
}

function requiredNewSessionFlow(): Extract<NewSessionFlowState, { mode: "review" }> {
  const flow = createNewSessionFlow(snapshot, "abcdef", "web");
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
