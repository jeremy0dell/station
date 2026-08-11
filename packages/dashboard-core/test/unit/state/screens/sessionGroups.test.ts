import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import {
  createQuickGroupName,
  handleCreateGroupAction,
  handleCreateGroupKey,
  handleProjectMenuAction,
  handleProjectMenuKey,
  openCreateGroup,
  openProjectMenu,
  submitQuickGroup,
} from "../../../../src/state/screens/sessionGroups.js";
import {
  createGroupedDashboardSnapshot,
  createNoProjectsSnapshot,
} from "../../../fixtures/snapshots.js";

describe("Session Group screens", () => {
  it("opens the Project menu on Quick Group and returns focus to the menu cell", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });

    const opened = openProjectMenu(state, "web");
    const closed = handleProjectMenuAction(opened, "cancel").state;

    expect(opened.screen).toEqual({ name: "projectMenu", projectId: "web", focus: "quickGroup" });
    expect(closed.screen).toEqual({ name: "dashboard" });
    expect(closed.dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("web"),
      cellId: "menu",
    });
  });

  it("opens Create Group with an empty focused name and Quick Session off", () => {
    const state = createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() });

    const opened = openCreateGroup(state, "web", "projectMenu");

    expect(opened.screen).toMatchObject({
      name: "createGroup",
      projectId: "web",
      draftName: { value: "", cursor: 0 },
      quickSession: false,
      focus: "name",
      submitting: false,
      returnTo: "projectMenu",
    });
  });

  it("cycles Project menu rows and lets G invoke the same Quick Group operation", () => {
    const opened = openProjectMenu(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "web",
    );
    const wrapped = handleProjectMenuKey(opened, { input: "", upArrow: true }).state;
    const transition = handleProjectMenuKey(opened, { input: "G" });

    expect(wrapped.screen).toMatchObject({ name: "projectMenu", focus: "settings" });
    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "createSessionGroup",
        projectId: "web",
        name: expect.stringMatching(/^Quick Group [0-9a-f]{6}$/),
        quickSession: true,
      }),
    ]);
  });

  it("edits Name, toggles Quick Session, traverses controls, and cancels to its invoker", () => {
    const opened = openCreateGroup(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "web",
      "projectMenu",
    );
    const named = handleCreateGroupKey(opened, { input: "Release" }).state;
    const quickFocused = handleCreateGroupKey(named, { input: "", downArrow: true }).state;
    const toggled = handleCreateGroupKey(quickFocused, { input: "\r", return: true }).state;
    const createFocused = handleCreateGroupKey(toggled, { input: "", downArrow: true }).state;
    const cancelFocused = handleCreateGroupKey(createFocused, {
      input: "",
      rightArrow: true,
    }).state;
    const cancelled = handleCreateGroupKey(cancelFocused, { input: "\r", return: true }).state;

    expect(named.screen).toMatchObject({ draftName: { value: "Release", cursor: 7 } });
    expect(toggled.screen).toMatchObject({ focus: "quickSession", quickSession: true });
    expect(cancelFocused.screen).toMatchObject({ focus: "cancel" });
    expect(cancelled.screen).toEqual({ name: "projectMenu", projectId: "web", focus: "newGroup" });
  });

  it("submits one trimmed create command and keeps the sheet pending", () => {
    const state = openCreateGroup(
      createInitialTuiState({ initialSnapshot: createGroupedDashboardSnapshot() }),
      "web",
      "projectMenu",
    );
    const named = {
      ...state,
      screen: {
        ...state.screen,
        draftName: { value: "  Launches  ", cursor: 12 },
      },
    };

    const transition = handleCreateGroupAction(named, "create");

    expect(transition.state.screen).toMatchObject({ name: "createGroup", submitting: true });
    expect(transition.operations).toEqual([
      expect.objectContaining({
        type: "createSessionGroup",
        projectId: "web",
        name: "Launches",
        quickSession: false,
        command: {
          type: "sessionGroup.create",
          payload: { projectId: "web", name: "Launches" },
        },
      }),
    ]);
  });

  it("generates an independent six-hex Quick Group name and regenerates collisions", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const withCollision = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.map((group, index) =>
        index === 0 ? { ...group, name: "Quick Group a1b2c3" } : group,
      ),
    };
    const tokens = ["a1b2c3", "d4e5f6"];

    expect(createQuickGroupName(withCollision, "web", () => tokens.shift() ?? "000000")).toBe(
      "Quick Group d4e5f6",
    );
  });

  it("targets the focused row's owning Project and falls back to the first Project", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const focused = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.group("group_api"),
        cellId: "identity",
      },
    });

    expect(submitQuickGroup(focused, { tokenFactory: () => "abcdef" }).operations).toEqual([
      expect.objectContaining({ projectId: "api", name: "Quick Group abcdef", quickSession: true }),
    ]);
    expect(
      submitQuickGroup({ ...focused, dashboardFocus: undefined }, { tokenFactory: () => "123456" })
        .operations,
    ).toEqual([
      expect.objectContaining({ projectId: "web", name: "Quick Group 123456", quickSession: true }),
    ]);
    expect(
      submitQuickGroup(
        { ...focused, collapsedProjectIds: new Set(["api"]) },
        { tokenFactory: () => "654321" },
      ).operations,
    ).toEqual([
      expect.objectContaining({ projectId: "web", name: "Quick Group 654321", quickSession: true }),
    ]);
  });

  it("uses the existing project-not-configured feedback when no Project exists", () => {
    const state = createInitialTuiState({ initialSnapshot: createNoProjectsSnapshot() });

    const transition = submitQuickGroup(state, { tokenFactory: () => "abcdef" });

    expect(transition.operations).toBeUndefined();
    expect(transition.state.toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "No project is configured for a new session.",
    });
  });
});
