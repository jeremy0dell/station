import { describe, expect, it } from "vitest";
import { createEditableTextInputState } from "../../../src/components/EditableTextInput/editing.js";
import { dashboardRowIds, selectDashboardTree } from "../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

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

  it("hard-projects applied matches and rebuilds gaps between retained projects", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "api" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(tree.visibleRows.map((row) => row.id)).toEqual([
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(tree.visibleRows.some(({ payload }) => payload.type === "projectGap")).toBe(false);
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
