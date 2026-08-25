import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
import { activateDashboardCell } from "../../../src/state/dashboardCells.js";
import {
  clearDashboardFocus,
  focusDashboardSession,
  focusedChooserSession,
  focusNextNeedsMe,
  moveDashboardChooserCursor,
  moveDashboardCursor,
  moveDashboardCursorHorizontal,
  reconcileDashboardFocus,
} from "../../../src/state/dashboardFocus.js";
import { createInitialTuiState, replaceSnapshot } from "../../../src/state/screen.js";
import { toggleDashboardProjectCollapsed } from "../../../src/state/screens/projectCollapse.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../fixtures/snapshots.js";

describe("dashboard cursor", () => {
  it("bridges a canonical session id to its branded identity cell", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });

    expect(focusDashboardSession(state, "ses_wt_web_idle").dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_idle"),
      cellId: "identity",
    });
    expect(focusDashboardSession(state, "missing").dashboardFocus).toBeUndefined();
    expect(clearDashboardFocus(state)).toBe(state);
  });

  it("enters relative to renderer-visible semantic identities", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const visible = [
      dashboardRowIds.session("ses_wt_web_idle"),
      dashboardRowIds.session("ses_wt_web_unknown"),
      dashboardRowIds.session("ses_wt_web_stuck"),
    ];

    expect(moveDashboardCursor(state, 1, visible).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_idle"),
      cellId: "identity",
    });
    expect(moveDashboardCursor(state, -1, visible).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_stuck"),
      cellId: "identity",
    });
  });

  it("moves through dashboard rows and enters headers at their default cell", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_stuck"),
        cellId: "identity",
      },
    });

    expect(moveDashboardCursor(state, 1).dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("api"),
      cellId: "identity",
    });
    expect(moveDashboardCursor(moveDashboardCursor(state, 1), -1).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_stuck"),
      cellId: "identity",
    });
  });

  it("clamps horizontal movement across the four ordered Project cells", () => {
    const snapshot = createDashboardSnapshot();
    let state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: dashboardRowIds.project("web"), cellId: "identity" },
    });

    state = moveDashboardCursorHorizontal(state, -1);
    expect(state.dashboardFocus?.cellId).toBe("identity");
    state = moveDashboardCursorHorizontal(state, 1);
    expect(state.dashboardFocus?.cellId).toBe("shell");
    state = moveDashboardCursorHorizontal(state, 1);
    expect(state.dashboardFocus?.cellId).toBe("quickSession");
    state = moveDashboardCursorHorizontal(state, 1);
    expect(state.dashboardFocus?.cellId).toBe("menu");
    expect(moveDashboardCursorHorizontal(state, 1)).toBe(state);
  });

  it("keeps Left and Right inert on single-cell session rows", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });
    expect(moveDashboardCursorHorizontal(state, 1)).toBe(state);
  });

  it("clamps horizontal movement across the three ordered Group cells", () => {
    const snapshot = createGroupedDashboardSnapshot();
    let state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: dashboardRowIds.group("group_active"), cellId: "identity" },
    });

    state = moveDashboardCursorHorizontal(state, 1);
    expect(state.dashboardFocus?.cellId).toBe("quickSession");
    state = moveDashboardCursorHorizontal(state, 1);
    expect(state.dashboardFocus?.cellId).toBe("menu");
    expect(moveDashboardCursorHorizontal(state, 1)).toBe(state);
    expect(moveDashboardCursorHorizontal(state, -1).dashboardFocus?.cellId).toBe("quickSession");
  });

  it("skips suppressed Group cells and reconciles stale action focus to identity", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const rowId = dashboardRowIds.group("group_active");
    let menuOnly = createInitialTuiState({
      initialSnapshot: snapshot,
      groupHeaderActionVisibility: { quickSession: false },
      dashboardFocus: { rowId, cellId: "identity" },
    });

    menuOnly = moveDashboardCursorHorizontal(menuOnly, 1);
    expect(menuOnly.dashboardFocus).toEqual({ rowId, cellId: "menu" });
    expect(moveDashboardCursorHorizontal(menuOnly, -1).dashboardFocus).toEqual({
      rowId,
      cellId: "identity",
    });

    const identityOnly = createInitialTuiState({
      initialSnapshot: snapshot,
      groupHeaderActionVisibility: { quickSession: false, menu: false },
      dashboardFocus: { rowId, cellId: "menu" },
    });
    expect(identityOnly.dashboardFocus).toEqual({ rowId, cellId: "identity" });
    expect(moveDashboardCursorHorizontal(identityOnly, 1)).toBe(identityOnly);
  });

  it("skips inert Group frame rows during vertical traversal", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });

    expect(moveDashboardCursor(state, 1).dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_build"),
      cellId: "identity",
    });
  });

  it("uses a chooser policy that skips containers, local rows, and pending sessions", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: dashboardRowIds.project("web"), cellId: "identity" },
      localRows: {
        pendingCreate: [
          {
            localId: "pending",
            projectId: "web",
            title: "A pending row",
            branch: "pending-row",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [
          {
            localId: "start:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            operation: "startAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    });

    const moved = moveDashboardChooserCursor(state, 1);
    expect(moved.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_attention"),
      cellId: "identity",
    });
    expect(focusedChooserSession(moved)?.id).toBe("ses_wt_web_attention");
  });

  it("rejects pending rows from chooser Enter eligibility", () => {
    const snapshot = createDashboardSnapshot();
    const rowId = dashboardRowIds.session("ses_wt_web_working");
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId, cellId: "identity" },
      localRows: {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [
          {
            localId: "start:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            operation: "startAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    });

    expect(focusedChooserSession(state)).toBeUndefined();
  });

  it("cycles needs-attention sessions using the controller policy", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_attention"),
        cellId: "identity",
      },
    });

    expect(focusNextNeedsMe(state).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_stuck"),
      cellId: "identity",
    });
    expect(focusNextNeedsMe(focusNextNeedsMe(state)).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_attention"),
      cellId: "identity",
    });
  });

  it("recovers a collapse-hidden child to the Project identity cell", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });

    expect(toggleDashboardProjectCollapsed(state, "web").dashboardFocus).toEqual({
      rowId: dashboardRowIds.project("web"),
      cellId: "identity",
    });
  });

  it("keeps Group identity focused on collapse and recovers a hidden member to it", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const groupId = dashboardRowIds.group("group_active");
    const focusedGroup = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: groupId, cellId: "identity" },
    });
    const collapsed = activateDashboardCell(focusedGroup, groupId, "identity").state;

    expect(collapsed.collapsedGroupIds.has("group_active")).toBe(true);
    expect(collapsed.dashboardFocus).toEqual({ rowId: groupId, cellId: "identity" });

    const focusedMember = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });
    const hidden = reconcileDashboardFocus(focusedMember, {
      ...focusedMember,
      collapsedGroupIds: new Set(["group_active"]),
    });
    expect(hidden.dashboardFocus).toEqual({ rowId: groupId, cellId: "identity" });
  });

  it("follows a focused session across canonical Group membership replacement", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const sessionId = dashboardRowIds.session("ses_wt_web_idle");
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId: sessionId, cellId: "identity" },
      collapsedGroupIds: ["group_build"],
    });
    const moved = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.map((group) => {
        if (group.id === "group_active") {
          return {
            ...group,
            sessionIds: group.sessionIds.filter((id) => id !== "ses_wt_web_idle"),
          };
        }
        return group.id === "group_build"
          ? { ...group, sessionIds: [...group.sessionIds, "ses_wt_web_idle"] }
          : group;
      }),
    };

    expect(replaceSnapshot(previous, moved).dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_build"),
      cellId: "identity",
    });
  });

  it("uses positional fallback when a focused Group disappears without pruning collapse state", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.group("group_active"),
        cellId: "menu",
      },
      collapsedGroupIds: ["group_active", "missing_group"],
    });
    const removed = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups
        .filter((group) => group.id !== "group_active")
        .map((group) => {
          if (group.id !== "group_build") return group;
          const { parentGroupId: _removedParent, ...rootGroup } = group;
          return rootGroup;
        }),
    };
    const next = replaceSnapshot(previous, removed);

    expect(next.dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_build"),
      cellId: "identity",
    });
    expect(next.collapsedGroupIds).toEqual(previous.collapsedGroupIds);
  });

  it("preserves exact identity without storing renderer resize state", () => {
    const snapshot = createDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
    });
    const next = reconcileDashboardFocus(previous, previous);

    expect(next.dashboardFocus).toEqual(previous.dashboardFocus);
    expect(next).toBe(previous);
  });

  it("falls to the next retained position after filtering removes the focused row", () => {
    const snapshot = createDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_idle"),
        cellId: "identity",
      },
    });
    const next = reconcileDashboardFocus(previous, {
      ...previous,
      persistentFilter: { query: "api" },
    });

    expect(next.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_api_working"),
      cellId: "identity",
    });
  });

  it("uses the preceding eligible row when snapshot replacement removes the final row", () => {
    const snapshot = createDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
    });
    const withoutApi = {
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== "api"),
      rows: snapshot.rows.filter((row) => row.projectId !== "api"),
      sessions: snapshot.sessions.filter((session) => session.projectId !== "api"),
    };

    expect(replaceSnapshot(previous, withoutApi).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_stuck"),
      cellId: "identity",
    });
  });

  it("reconciles choose-row screens under chooser eligibility", () => {
    const snapshot = createDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_working"),
        cellId: "identity",
      },
    });
    const next = reconcileDashboardFocus(previous, {
      ...previous,
      screen: { name: "removeWorktree", step: "chooseSlot" },
      localRows: {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [
          {
            localId: "start:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            operation: "startAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    });

    expect(next.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_attention"),
      cellId: "identity",
    });
  });
});
