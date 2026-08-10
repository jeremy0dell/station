import { describe, expect, it } from "vitest";
import { createEditableTextInputState } from "../../../src/components/EditableTextInput/editing.js";
import { dashboardRowIds, selectDashboardTree } from "../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
  fixtureNow,
} from "../../fixtures/snapshots.js";

describe("dashboard tree", () => {
  it("projects the current Project to Session hierarchy with stable ids, gaps, and cells", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toEqual([
      "project:web",
      "session:ses_wt_web_working",
      "session:ses_wt_web_attention",
      "session:ses_wt_web_exited",
      "session:ses_wt_web_idle",
      "session:ses_wt_web_unknown",
      "session:ses_wt_web_stuck",
      "gap:api",
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(tree.rowById.get(dashboardRowIds.project("web"))).toMatchObject({
      depth: 0,
      cells: ["identity", "shell", "quickSession", "defaultAgent"],
      defaultCell: "identity",
      payload: { type: "projectHeader", collapsed: false },
    });
    expect(tree.rowById.get(dashboardRowIds.session("ses_wt_web_working"))).toMatchObject({
      depth: 1,
      parentId: "project:web",
      cells: ["identity"],
      defaultCell: "identity",
      payload: { type: "session" },
    });
    expect(tree.rowById.get(dashboardRowIds.gap("api"))).toMatchObject({
      depth: 0,
      cells: [],
      payload: { type: "projectGap", projectId: "api" },
    });
  });

  it("joins canonical sessions only and renders a truly empty project action", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      sessions: base.sessions.filter((session) => session.projectId !== "web"),
    };
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toContain("empty:web");
    expect(tree.visibleRows.map((row) => row.id)).not.toContain("session:ses_wt_web_no_agent");
    expect(tree.rowById.get(dashboardRowIds.empty("web"))).toMatchObject({
      parentId: "project:web",
      cells: ["addSession"],
      defaultCell: "addSession",
      payload: { type: "emptyProject" },
    });
  });

  it("merges canonical and optimistic rows by title and prunes represented project branches", () => {
    const snapshot = createDashboardSnapshot();
    const titled = {
      ...snapshot,
      rows: snapshot.rows.map((row) =>
        row.id === "wt_web_stuck" ? { ...row, title: "aaa stable task" } : row,
      ),
    };
    const state = createInitialTuiState({
      initialSnapshot: titled,
      localRows: {
        pendingCreate: [
          {
            localId: "local_create_1",
            projectId: "web",
            title: "bbb pending task",
            branch: "station-pending-1",
            harnessProvider: "codex",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
          {
            localId: "represented",
            projectId: "web",
            title: "represented",
            branch: "fix-nav-mobile",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const tree = selectDashboardTree(titled, state, state.screen);
    const rowIds = tree.visibleRows
      .filter(({ payload }) => payload.type === "session" || payload.type === "createLocalRow")
      .slice(0, 3)
      .map((row) => row.id);

    expect(rowIds).toEqual([
      "session:ses_wt_web_stuck",
      "create:local_create_1",
      "session:ses_wt_web_working",
    ]);
    expect(tree.rowById.has(dashboardRowIds.create("represented"))).toBe(false);
    expect(tree.rowById.get(dashboardRowIds.create("local_create_1"))).toMatchObject({
      cells: [],
      payload: {
        type: "createLocalRow",
        presentation: {
          title: "bbb pending task",
          agent: "codex",
          activity: "starting session...",
        },
      },
    });
  });

  it("keeps failed optimistic rows when their project branch is represented", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [
          {
            localId: "represented-pending",
            projectId: "web",
            title: "Pending launch",
            branch: "fix-nav-mobile",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [
          {
            localId: "represented-failed",
            projectId: "web",
            title: "Failed launch",
            branch: "fix-nav-mobile",
            error: { tag: "ClientObserverError", code: "FAILED", message: "Launch failed." },
            expiresAt: Date.now() + 4_000,
          },
        ],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.rowById.has(dashboardRowIds.create("represented-pending"))).toBe(false);
    expect(tree.rowById.get(dashboardRowIds.create("represented-failed"))).toMatchObject({
      cells: [],
      payload: {
        type: "createLocalRow",
        row: { status: "failed" },
        presentation: { title: "Failed launch", activity: "Launch failed." },
      },
    });
  });

  it("retains collapse-hidden descendants in lookup with their visible collapsed ancestor", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      collapsedProjectIds: ["web"],
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const sessionId = dashboardRowIds.session("ses_wt_web_idle");

    expect(tree.visibleRows.map((row) => row.id)).not.toContain(sessionId);
    expect(tree.rowById.has(sessionId)).toBe(true);
    expect(tree.collapsedAncestorById.get(sessionId)).toBe(dashboardRowIds.project("web"));
  });

  it("projects flat Group blocks with direct canonical counts and groups-first ordering", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toEqual([
      "project:web",
      "group:group_active",
      "session:ses_wt_web_attention",
      "session:ses_wt_web_idle",
      "group:group_build",
      "session:ses_wt_web_working",
      "group:group_empty",
      "session:ses_wt_web_exited",
      "session:ses_wt_web_unknown",
      "session:ses_wt_web_stuck",
      "gap:api",
      "project:api",
      "group:group_api",
      "session:ses_wt_api_working",
    ]);
    expect(tree.rowById.get(dashboardRowIds.group("group_build"))).toMatchObject({
      depth: 1,
      parentId: "project:web",
      cells: ["identity", "quickSession", "menu"],
      defaultCell: "identity",
      payload: {
        type: "groupHeader",
        collapsed: false,
        sessionCount: 1,
        visibleSessionCount: 1,
        group: { id: "group_build", parentGroupId: "group_active" },
      },
    });
    expect(tree.rowById.get(dashboardRowIds.session("ses_wt_web_working"))).toMatchObject({
      depth: 2,
      parentId: "group:group_build",
    });
    expect(tree.rowById.get(dashboardRowIds.group("group_empty"))?.payload).toMatchObject({
      type: "groupHeader",
      sessionCount: 0,
      visibleSessionCount: 0,
    });
  });

  it("interleaves whole Group blocks with root rows and keeps optimistic rows ungrouped", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      groupOrderingMode: "alphabetical-interleaved",
      localRows: {
        pendingCreate: [
          {
            localId: "pending",
            projectId: "web",
            title: "Draft",
            branch: "draft",
            createdAt: fixtureNow,
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const webChildren = tree.visibleRows
      .filter((row) => row.parentId === dashboardRowIds.project("web"))
      .map((row) => row.id);

    expect(webChildren).toEqual([
      "group:group_active",
      "group:group_build",
      "session:ses_wt_web_exited",
      "create:pending",
      "group:group_empty",
      "session:ses_wt_web_unknown",
      "session:ses_wt_web_stuck",
    ]);
  });

  it("orders equal labels by Group precedence and stable Group identity", () => {
    const base = createGroupedDashboardSnapshot();
    const snapshot = {
      ...base,
      sessionGroups: base.sessionGroups.map((group) =>
        group.id === "group_empty"
          ? { ...group, name: "done-run" }
          : group.id === "group_active" || group.id === "group_build"
            ? { ...group, name: "same" }
            : group,
      ),
    };
    const originalGroups = snapshot.sessionGroups.map((group) => group.id);
    const originalSessions = snapshot.sessions.map((session) => session.id);
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      groupOrderingMode: "alphabetical-interleaved",
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const webChildren = tree.visibleRows
      .filter((row) => row.parentId === dashboardRowIds.project("web"))
      .map((row) => row.id);

    expect(webChildren.indexOf("group:group_empty")).toBeLessThan(
      webChildren.indexOf("session:ses_wt_web_exited"),
    );
    expect(webChildren.indexOf("group:group_active")).toBeLessThan(
      webChildren.indexOf("group:group_build"),
    );
    expect(snapshot.sessionGroups.map((group) => group.id)).toEqual(originalGroups);
    expect(snapshot.sessions.map((session) => session.id)).toEqual(originalSessions);
  });

  it("uses Group and Project collapse as nested visible-ancestor recovery", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const memberId = dashboardRowIds.session("ses_wt_web_idle");
    const groupState = createInitialTuiState({
      initialSnapshot: snapshot,
      collapsedGroupIds: ["group_active"],
    });
    const groupTree = selectDashboardTree(snapshot, groupState, groupState.screen);

    expect(groupTree.visibleIndexById.has(memberId)).toBe(false);
    expect(groupTree.collapsedAncestorById.get(memberId)).toBe(
      dashboardRowIds.group("group_active"),
    );

    const projectState = { ...groupState, collapsedProjectIds: new Set(["web"]) };
    const projectTree = selectDashboardTree(snapshot, projectState, projectState.screen);
    expect(projectTree.collapsedAncestorById.get(memberId)).toBe(dashboardRowIds.project("web"));
  });

  it("marks a Group whose direct visible member owns focus", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.rowById.get(dashboardRowIds.group("group_active"))?.containsFocusedRow).toBe(true);
    expect(
      tree.rowById.get(dashboardRowIds.group("group_build"))?.containsFocusedRow,
    ).toBeUndefined();
  });

  it("retains Group containers and reports admitted direct members under an applied filter", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "active work" },
      collapsedGroupIds: ["group_build"],
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.rowById.get(dashboardRowIds.group("group_active"))?.payload).toMatchObject({
      type: "groupHeader",
      sessionCount: 2,
      visibleSessionCount: 2,
      persistentFilterMatch: { matched: true },
    });
    expect(tree.rowById.get(dashboardRowIds.group("group_build"))?.payload).toMatchObject({
      type: "groupHeader",
      collapsed: true,
      sessionCount: 1,
      visibleSessionCount: 0,
      persistentFilterMatch: { matched: false },
    });
    expect(tree.visibleRows.map((row) => row.id)).toContain("group:group_empty");
    expect(state.collapsedGroupIds.has("group_build")).toBe(true);
  });

  it("keeps canonical Group counts when a direct member lacks renderable metadata", () => {
    const base = createGroupedDashboardSnapshot();
    const snapshot = {
      ...base,
      rows: base.rows.filter((row) => row.id !== "wt_web_idle"),
    };
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.rowById.get(dashboardRowIds.group("group_active"))?.payload).toMatchObject({
      type: "groupHeader",
      sessionCount: 2,
      visibleSessionCount: 1,
    });
    expect(tree.rowById.has(dashboardRowIds.session("ses_wt_web_idle"))).toBe(false);
  });

  it("keeps draft filtering soft and decorates row and project matches", () => {
    const snapshot = createDashboardSnapshot();
    const state = {
      ...createInitialTuiState({ initialSnapshot: snapshot }),
      screen: {
        name: "persistentFilter" as const,
        draft: createEditableTextInputState("slow-tests"),
        draftConditions: [],
      },
    };
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows).toHaveLength(10);
    expect(tree.persistentFilter).toMatchObject({ source: "draft", matchCount: 1, totalCount: 7 });
    expect(tree.rowById.get(dashboardRowIds.session("ses_wt_web_stuck"))?.payload).toMatchObject({
      type: "session",
      persistentFilterMatch: { matched: true, dimmed: false },
    });
    expect(tree.rowById.get(dashboardRowIds.project("api"))?.payload).toMatchObject({
      type: "projectHeader",
      persistentFilterMatch: { matched: false },
    });
  });

  it("hard-projects applied rows while retaining durable Project context", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "api" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toEqual([
      "project:web",
      "gap:api",
      "project:api",
      "session:ses_wt_api_working",
    ]);
  });

  it("does not fabricate an empty action when an applied filter removes a nonempty project's rows", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "web" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toContain("project:web");
    expect(tree.visibleRows.map((row) => row.id)).not.toContain("empty:web");
  });

  it("decorates only the exact focused cell and never duplicates a row id", () => {
    const snapshot = createDashboardSnapshot();
    const rowId = dashboardRowIds.project("web");
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId, cellId: "quickSession" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.rowById.get(rowId)?.focusedCellId).toBe("quickSession");
    expect(tree.visibleRows.filter((row) => row.focusedCellId !== undefined)).toHaveLength(1);
    expect(new Set(tree.visibleRows.map((row) => row.id)).size).toBe(tree.visibleRows.length);
  });
});
