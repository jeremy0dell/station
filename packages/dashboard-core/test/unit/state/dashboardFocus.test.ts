import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
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
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

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

  it("enters relative to the visible terminal window", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      scrollOffset: 4,
      terminalRows: 10,
    });

    expect(moveDashboardCursor(state, 1).dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_idle"),
      cellId: "identity",
    });
    expect(moveDashboardCursor(state, -1).dashboardFocus).toEqual({
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
    expect(state.dashboardFocus?.cellId).toBe("defaultAgent");
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

  it("uses a chooser policy that skips headers, gaps, local rows, and pending sessions", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
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

  it("preserves exact identity through resize and follows it into view", () => {
    const snapshot = createDashboardSnapshot();
    const previous = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_api_working"),
        cellId: "identity",
      },
    });
    const next = reconcileDashboardFocus(previous, { ...previous, terminalRows: 10 });

    expect(next.dashboardFocus).toEqual(previous.dashboardFocus);
    expect(next.scrollOffset).toBe(7);
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
