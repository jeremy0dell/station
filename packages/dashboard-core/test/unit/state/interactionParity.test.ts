import {
  type AddProjectActionId,
  addProjectActions,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  createInitialTuiState,
  createNewSessionFlow,
  handleTuiAction,
  handleTuiKey,
  newSessionIntentForAction,
  openAddProject,
  openForkDetailsForRow,
  openRemoveWorktreeConfirmForRow,
  transitionNewSessionFlow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot, createZeroWorktreeSnapshot } from "../../fixtures/snapshots.js";

const context = { cwd: "/workspace", homeDir: "/home/example" };

describe("primary workflow interaction parity", () => {
  it("derives visible Add Project controls and availability from core descriptors", () => {
    let state = openAddProject(createInitialTuiState(), context);
    expect(actionIds(state)).toEqual(["start.open", "start.cancel"]);

    state = applyAddProjectFolderReviewed(state, {
      selectedPath: "/workspace/station",
      gitRoot: "/workspace/station",
      id: "station",
      label: "Station",
    });
    expect(actionIds(state)).toEqual([
      "review.submit",
      "review.editId",
      "review.chooseFolder",
      "review.cancel",
    ]);
  });

  it("aligns Add Project arrow navigation with each action layout", () => {
    let state = openAddProject(createInitialTuiState(), context);
    state = applyAddProjectFolderReviewed(state, {
      selectedPath: "/workspace/station",
      gitRoot: "/workspace/station",
      id: "station",
      label: "Station",
    });

    const down = handleTuiKey(state, { input: "", downArrow: true }, context).state;
    expect(addProjectFocus(down)).toBe("submit");

    const right = handleTuiKey(state, { input: "", rightArrow: true }, context).state;
    expect(addProjectFocus(right)).toBe("editId");

    const left = handleTuiKey(right, { input: "", leftArrow: true }, context).state;
    expect(addProjectFocus(left)).toBe("submit");

    const editing = handleTuiKey(state, { input: "N" }, context).state;
    expect(addProjectEditFocus(editing)).toBe("save");
    const editingRight = handleTuiKey(editing, { input: "", rightArrow: true }, context).state;
    expect(addProjectEditFocus(editingRight)).toBe("save");
    const editingDown = handleTuiKey(editing, { input: "", downArrow: true }, context).state;
    expect(addProjectEditFocus(editingDown)).toBe("back");

    let failed = openAddProject(createInitialTuiState(), context);
    failed = applyAddProjectFolderReviewFailed(
      failed,
      "/workspace/station",
      new Error("review failed"),
    );
    const failedDown = handleTuiKey(failed, { input: "", downArrow: true }, context).state;
    expect(addProjectFocus(failedDown)).toBe("retry");
    const failedRight = handleTuiKey(failed, { input: "", rightArrow: true }, context).state;
    expect(addProjectFocus(failedRight)).toBe("chooseFolder");
  });

  it("keeps Git-invalid and submitting Add Project controls inert in core", () => {
    let invalid = openAddProject(createInitialTuiState(), context);
    invalid = applyAddProjectFolderReviewed(invalid, {
      selectedPath: "/workspace/notes",
      id: "notes",
      label: "Notes",
    });
    expect(actionEnabled(invalid, "review.submit")).toBe(false);
    expect(
      handleTuiAction(invalid, { type: "addProject.activate", actionId: "review.submit" }, context)
        .state,
    ).toBe(invalid);

    if (invalid.screen.name !== "addProject" || invalid.screen.flow.mode !== "review") {
      throw new Error("expected Add Project review");
    }
    const submitting = {
      ...invalid,
      screen: {
        name: "addProject" as const,
        flow: { ...invalid.screen.flow, submitting: true },
      },
    };
    expect(addProjectActions(submitting.screen.flow).every((action) => !action.enabled)).toBe(true);
    expect(
      handleTuiAction(
        submitting,
        { type: "addProject.activate", actionId: "review.cancel" },
        context,
      ).state,
    ).toBe(submitting);
  });

  it("keeps unavailable Create Session inert across semantic and keyboard activation", () => {
    const snapshot = createDashboardSnapshot();
    const unavailable = {
      ...snapshot,
      harnesses: [{ id: "codex", label: "Codex" }],
      providerHealth: {
        ...snapshot.providerHealth,
        codex: {
          providerId: "codex",
          providerType: "harness" as const,
          status: "unavailable" as const,
          lastCheckedAt: snapshot.generatedAt,
        },
      },
    };
    const flow = createNewSessionFlow(unavailable, "aaaaaa");
    if (flow === undefined) throw new Error("expected New Session");
    const state = {
      ...createInitialTuiState(),
      snapshot: unavailable,
      screen: { name: "newSession" as const, flow },
    };

    expect(
      handleTuiAction(state, { type: "newSession.activate", actionId: "review.create" }, context),
    ).toEqual({ state });
    expect(handleTuiKey(state, { input: "C" }, context)).toEqual({ state });
    expect(handleTuiKey(state, { input: "\r", return: true }, context)).toEqual({ state });
  });

  it("submits Rename Session through the same semantic and Enter transition", () => {
    const opened = handleTuiKey(
      handleTuiKey(
        createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
        { input: "R" },
        context,
      ).state,
      { input: "4" },
      context,
    ).state;
    const edited = "semantic"
      .split("")
      .reduce((state, input) => handleTuiKey(state, { input }, context).state, opened);

    const semantic = handleTuiAction(edited, { type: "renameSession.submit" }, context);
    const keyboard = handleTuiKey(edited, { input: "\r", return: true }, context);

    expect(semantic.state.screen).toEqual({ name: "dashboard" });
    expect(semantic.operations).toEqual(keyboard.operations);
    expect(semantic.operations).toEqual([
      {
        type: "renameSession",
        sessionId: "ses_wt_web_idle",
        title: "semantic",
        command: {
          type: "session.rename",
          payload: { sessionId: "ses_wt_web_idle", title: "semantic" },
        },
      },
    ]);
    expect(semantic.state.localRows.pendingRenameTitles?.ses_wt_web_idle?.title).toBe("semantic");
    expect(keyboard.state.localRows.pendingRenameTitles?.ses_wt_web_idle?.title).toBe("semantic");
  });

  it("gives every visible Create Session control a semantic intent", () => {
    const review = createNewSessionFlow(createDashboardSnapshot(), "aaaaaa");
    if (review === undefined) throw new Error("expected New Session");
    for (const id of ["review.project", "review.name", "review.agent", "review.create"] as const) {
      expect(newSessionIntentForAction(review, id).type, id).not.toBe("none");
    }

    const edit = transitionNewSessionFlow(review, { type: "editName" });
    if (edit?.mode !== "editName") throw new Error("expected name editor");
    for (const id of ["editName.name", "editName.save", "editName.back"] as const) {
      expect(newSessionIntentForAction(edit, id).type, id).not.toBe("none");
    }
  });

  it("converges Remove pointer semantics with direct and focused activation", () => {
    const base = openRemoveWorktreeConfirmForRow(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "ses_wt_web_idle",
    );
    const semantic = handleTuiAction(
      base,
      { type: "removeWorktree.activate", actionId: "confirm.delete" },
      context,
    );
    const direct = handleTuiKey(base, { input: "y" }, context);
    const focused = handleTuiKey(
      handleTuiKey(base, { input: "", leftArrow: true }, context).state,
      { input: "\r", return: true },
      context,
    );

    const semanticOperation = semantic.operations?.[0];
    const directOperation = direct.operations?.[0];
    const focusedOperation = focused.operations?.[0];
    if (
      semanticOperation?.type !== "removeWorktree" ||
      directOperation?.type !== "removeWorktree" ||
      focusedOperation?.type !== "removeWorktree"
    ) {
      throw new Error("expected Remove Worktree operations");
    }
    expect(semanticOperation.command).toEqual(directOperation.command);
    expect(focusedOperation.command).toEqual(directOperation.command);
    expect(semantic.state.screen).toEqual({ name: "dashboard" });
    expect(focused.state.screen).toEqual({ name: "dashboard" });
  });

  it("converges Fork Copy pointer semantics with focused Enter", () => {
    const base = openForkDetailsForRow(
      createInitialTuiState({ initialSnapshot: createDashboardSnapshot() }),
      "ses_wt_web_idle",
      { branchToken: "aaaaaa" },
    );
    const semantic = handleTuiAction(
      base,
      { type: "forkSession.activate", actionId: "details.copyDirty" },
      context,
    );
    const keyboard = handleTuiKey(
      handleTuiKey(base, { input: "", downArrow: true }, context).state,
      { input: "\r", return: true },
      context,
    );

    expect(semantic.state.screen).toEqual(keyboard.state.screen);
    expect(semantic.operations).toBeUndefined();
    expect(keyboard.operations).toBeUndefined();
  });

  it.each([
    ["primary", 0],
    ["shell", 1],
    ["quickSession", 2],
    ["defaultAgent", 3],
  ] as const)("converges project-header %s pointer semantics with focused Enter", (actionId, rights) => {
    const base = createInitialTuiState({ initialSnapshot: createDashboardSnapshot() });
    const semantic = handleTuiAction(
      base,
      { type: "dashboard.projectHeader.activate", projectId: "web", actionId },
      context,
    );

    let keyboardState = handleTuiKey(base, { input: "", downArrow: true }, context).state;
    for (let index = 0; index < rights; index += 1) {
      keyboardState = handleTuiKey(keyboardState, { input: "", rightArrow: true }, context).state;
    }
    const keyboard = handleTuiKey(keyboardState, { input: "\r", return: true }, context);

    expect(semantic.state.dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "web",
      control: actionId,
    });
    expect(semantic.state.screen).toEqual(keyboard.state.screen);
    expect(semantic.state.collapsedProjectIds).toEqual(keyboard.state.collapsedProjectIds);
    if (actionId === "quickSession") {
      expect(semantic.operations?.[0]).toMatchObject({
        type: "quickCreateManagedSession",
        project: { id: "web" },
      });
      expect(keyboard.operations?.[0]).toMatchObject({
        type: "quickCreateManagedSession",
        project: { id: "web" },
      });
    } else {
      expect(semantic.operations).toEqual(keyboard.operations);
    }
  });

  it("converges empty-project pointer semantics with focused Enter", () => {
    const base = createInitialTuiState({ initialSnapshot: createZeroWorktreeSnapshot() });
    const semantic = handleTuiAction(
      base,
      { type: "dashboard.emptyProject.activate", projectId: "web" },
      context,
    );
    const focused = handleTuiKey(
      handleTuiKey(base, { input: "", downArrow: true }, context).state,
      { input: "", downArrow: true },
      context,
    ).state;
    const keyboard = handleTuiKey(focused, { input: "\r", return: true }, context);

    expect(semantic.state.dashboardFocus).toEqual({
      kind: "emptyProjectAction",
      projectId: "web",
    });
    expect(semantic.state.dashboardFocus).toEqual(keyboard.state.dashboardFocus);
    expect(semantic.operations?.[0]).toMatchObject({
      type: "quickCreateManagedSession",
      project: { id: "web" },
    });
    expect(keyboard.operations?.[0]).toMatchObject({
      type: "quickCreateManagedSession",
      project: { id: "web" },
    });
  });

  it("validates header and empty-project Quick Session before capability execution", () => {
    const snapshot = createDashboardSnapshot();
    const unavailable = {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === "web"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const state = createInitialTuiState({ initialSnapshot: unavailable });
    const blocked = handleTuiAction(
      state,
      {
        type: "dashboard.projectHeader.activate",
        projectId: "web",
        actionId: "quickSession",
      },
      context,
    );
    expect(blocked.operations).toBeUndefined();
    expect(blocked.state.dashboardFocus).toEqual({
      kind: "projectHeader",
      projectId: "web",
      control: "quickSession",
    });
    expect(blocked.state.toasts.at(-1)?.toast.kind).toBe("error");

    const emptySnapshot = createZeroWorktreeSnapshot();
    const unavailableEmpty = {
      ...emptySnapshot,
      projects: emptySnapshot.projects.map((project) =>
        project.id === "web"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const empty = handleTuiAction(
      createInitialTuiState({ initialSnapshot: unavailableEmpty }),
      { type: "dashboard.emptyProject.activate", projectId: "web" },
      context,
    );
    expect(empty.operations).toBeUndefined();
    expect(empty.state.dashboardFocus).toEqual({ kind: "emptyProjectAction", projectId: "web" });
    expect(empty.state.toasts.at(-1)?.toast.kind).toBe("error");

    const stale = handleTuiAction(
      state,
      {
        type: "dashboard.projectHeader.activate",
        projectId: "ghost",
        actionId: "shell",
      },
      context,
    );
    expect(stale).toEqual({ state });
  });
});

function addProjectFocus(state: ReturnType<typeof createInitialTuiState>): string | undefined {
  if (state.screen.name !== "addProject") return undefined;
  switch (state.screen.flow.mode) {
    case "review":
    case "failed":
      return state.screen.flow.actionFocus;
    case "start":
    case "choose":
    case "success":
      return undefined;
  }
}

function addProjectEditFocus(state: ReturnType<typeof createInitialTuiState>): string | undefined {
  return state.screen.name === "addProject" &&
    state.screen.flow.mode === "review" &&
    state.screen.flow.editingId !== undefined
    ? state.screen.flow.editIdActionFocus
    : undefined;
}

function actionIds(state: ReturnType<typeof createInitialTuiState>): AddProjectActionId[] {
  if (state.screen.name !== "addProject") throw new Error("expected Add Project");
  return addProjectActions(state.screen.flow).map((action) => action.id);
}

function actionEnabled(
  state: ReturnType<typeof createInitialTuiState>,
  actionId: AddProjectActionId,
): boolean | undefined {
  if (state.screen.name !== "addProject") throw new Error("expected Add Project");
  return addProjectActions(state.screen.flow).find((action) => action.id === actionId)?.enabled;
}
