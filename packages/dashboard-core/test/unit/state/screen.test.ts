import {
  type AddProjectFlowState,
  chooseStateForLoadedFolder,
  createAddProjectFlow,
  createEditableTextInputState,
  createInitialTuiState,
  createNewSessionFlow,
  dismissTuiScreenOnClickAway,
  failedStateForError,
  type NewSessionFlowState,
  reviewStateForFolder,
  successStateForProject,
  type TuiScreen,
  type TuiState,
  transitionNewSessionFlow,
  tuiScreenClickAwayMode,
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
const newEdit = requiredNewSessionTransition(newReview, { type: "editName" });
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

const screenPolicyCases: readonly [
  label: string,
  screen: TuiScreen,
  expected: "dismiss" | "passthrough",
][] = [
  ["dashboard", { name: "dashboard" }, "passthrough"],
  ["search", { name: "search", value: "api" }, "passthrough"],
  ["help", { name: "help" }, "dismiss"],
  ["project collapse picker", { name: "projectCollapse" }, "dismiss"],
  ["project settings picker", { name: "projectSettingsPicker" }, "dismiss"],
  ["project default-agent picker", { name: "projectDefaultAgent", projectId: "web" }, "dismiss"],
  ["remove choose-row", { name: "removeWorktree", step: "chooseSlot" }, "passthrough"],
  ["remove unavailable", { name: "removeWorktree", step: "unavailable" }, "dismiss"],
  [
    "remove confirmation",
    {
      name: "removeWorktree",
      step: "confirm",
      rowId: "ses_wt_web_idle",
      forceRequired: false,
      label: "web",
    },
    "dismiss",
  ],
  ["rename choose-row", { name: "renameSession", step: "chooseSlot" }, "passthrough"],
  ["rename details", renameEdit, "dismiss"],
  ["fork choose-row", { name: "fork", step: "chooseSlot" }, "passthrough"],
  ["fork details", forkDetails, "dismiss"],
  ["add project start", { name: "addProject", flow: addStart }, "dismiss"],
  ["add project choose", { name: "addProject", flow: addChoose }, "dismiss"],
  ["add project review", { name: "addProject", flow: addReview }, "dismiss"],
  ["add project success", { name: "addProject", flow: addSuccess }, "dismiss"],
  ["add project failed", { name: "addProject", flow: addFailed }, "dismiss"],
  ["new session review", { name: "newSession", flow: newReview }, "dismiss"],
  ["new session name editor", { name: "newSession", flow: newEdit }, "dismiss"],
  ["new session project picker", { name: "newSession", flow: newPickProject }, "dismiss"],
  ["new session agent picker", { name: "newSession", flow: newPickAgent }, "dismiss"],
  [
    "project settings list",
    {
      name: "projectSettings",
      projectId: "web",
      focus: "list",
      activeId: "agent",
      removeDraft: createEditableTextInputState(),
    },
    "dismiss",
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
    "dismiss",
  ],
  [
    "widget settings list",
    { name: "widgetSettings", focus: "list", cursor: 0, pickerCursor: 0 },
    "dismiss",
  ],
  [
    "widget add picker",
    { name: "widgetSettings", focus: "picker", cursor: 0, pickerCursor: 1 },
    "dismiss",
  ],
];

describe("TUI screen click-away policy", () => {
  it.each(screenPolicyCases)("classifies %s as %s", (_label, screen, expected) => {
    expect(tuiScreenClickAwayMode(screen)).toBe(expected);
  });

  it("backs nested New Session steps to review and discards the nested draft", () => {
    const edited: NewSessionFlowState = {
      ...newEdit,
      draftName: createEditableTextInputState("discard me"),
    };

    const dismissed = dismiss(withScreen({ name: "newSession", flow: edited }));

    expect(dismissed.screen).toEqual({
      name: "newSession",
      flow: { ...newReview, reviewFocus: "create" },
    });
    expect(dismiss(withScreen({ name: "newSession", flow: newPickProject })).screen).toEqual({
      name: "newSession",
      flow: { ...newReview, reviewFocus: "create" },
    });
    expect(dismiss(withScreen({ name: "newSession", flow: newReview })).screen).toEqual({
      name: "dashboard",
    });
  });

  it("cancels the topmost Add Project editor or filter before closing the flow", () => {
    const editing: AddProjectFlowState = {
      ...addReview,
      editingId: createEditableTextInputState("discard-me"),
    };
    const editorCancelled = dismiss(withScreen({ name: "addProject", flow: editing }));
    expect(editorCancelled.screen).toEqual({ name: "addProject", flow: addReview });
    expect(dismiss(editorCancelled).screen).toEqual({ name: "dashboard" });

    const filtering: AddProjectFlowState = {
      ...addChoose,
      filter: "station",
      filterMode: true,
      searchEntries: [{ name: "station", path: "/tmp/station", kind: "directory" }],
      searching: true,
      searchTruncated: true,
    };
    const filterCleared = dismiss({
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
    expect(dismiss(filterCleared).screen).toEqual({ name: "dashboard" });
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

      expect(dismiss(state).screen).toEqual({ name: "dashboard" });
    }
  });

  it("cancels remove information and confirmation without adding effects", () => {
    for (const screen of screenPolicyCases
      .map(([, screen]) => screen)
      .filter(
        (screen): screen is Extract<TuiScreen, { name: "removeWorktree" }> =>
          screen.name === "removeWorktree" && screen.step !== "chooseSlot",
      )) {
      const dismissed = dismiss(withScreen(screen));
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

    const pickerDismissed = dismiss(state);
    expect(pickerDismissed.screen).toEqual({
      name: "widgetSettings",
      focus: "list",
      cursor: 1,
      pickerCursor: 2,
    });
    expect(pickerDismissed.widgets).toBe(state.widgets);
    const panelDismissed = dismiss(pickerDismissed);
    expect(panelDismissed.screen).toEqual({ name: "dashboard" });
    expect(panelDismissed.widgets).toBe(state.widgets);
  });

  it("follows rename and fork returnTo contracts while row-choice modes pass through", () => {
    expect(dismiss(withScreen(renameEdit)).screen).toEqual({
      name: "renameSession",
      step: "chooseSlot",
    });
    expect(dismiss(withScreen({ ...renameEdit, returnTo: "dashboard" })).screen).toEqual({
      name: "dashboard",
    });
    expect(dismiss(withScreen(forkDetails)).screen).toEqual({ name: "fork", step: "chooseSlot" });
    expect(dismiss(withScreen({ ...forkDetails, returnTo: "dashboard" })).screen).toEqual({
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
      expect(dismiss(state)).toBe(state);
    }
  });
});

function withScreen(screen: TuiScreen): TuiState {
  return { ...createInitialTuiState({ initialSnapshot: snapshot }), screen };
}

function dismiss(state: TuiState): TuiState {
  return dismissTuiScreenOnClickAway(state);
}

function requiredNewSessionFlow(): Extract<NewSessionFlowState, { mode: "review" }> {
  const flow = createNewSessionFlow(snapshot, "abcdef", "web");
  if (flow === undefined) {
    throw new Error("Expected the dashboard fixture to support New Session.");
  }
  return flow;
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
