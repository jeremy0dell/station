import { describe, expect, it, vi } from "vitest";
import { dashboardRowIds } from "../../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../../src/state/screen.js";
import { handleDashboardRowChoiceKey } from "../../../../src/state/screens/rowChoose.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../../fixtures/snapshots.js";

describe("dashboard row chooser", () => {
  it.each([
    "removeWorktree",
    "renameSession",
    "fork",
  ] as const)("%s arrows enter only selectable canonical sessions", (name) => {
    const snapshot = createDashboardSnapshot();
    const base = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
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
    const state = {
      ...base,
      screen: { name, step: "chooseSlot" as const },
      dashboardFocus: { rowId: dashboardRowIds.project("web"), cellId: "identity" as const },
    };
    const commit = vi.fn((current, rowId) => ({ state: current, operations: [], rowId }));

    const moved = handleDashboardRowChoiceKey(state, { input: "", downArrow: true }, commit);
    expect(moved.state.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_attention"),
      cellId: "identity",
    });
    handleDashboardRowChoiceKey(moved.state, { input: "\r", return: true }, commit);
    expect(commit).toHaveBeenCalledWith(moved.state, "ses_wt_web_attention");
  });

  it("enters at the first eligible canonical session in the viewport", () => {
    const snapshot = createDashboardSnapshot();
    const state = {
      ...createInitialTuiState({
        initialSnapshot: snapshot,
        scrollOffset: 4,
        terminalRows: 10,
      }),
      screen: { name: "removeWorktree" as const, step: "chooseSlot" as const },
    };

    expect(
      handleDashboardRowChoiceKey(state, { input: "", downArrow: true }, (current) => ({
        state: current,
      })).state.dashboardFocus,
    ).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_idle"),
      cellId: "identity",
    });
  });

  it("converges Enter and slot keys on the same SessionId commit", () => {
    const snapshot = createDashboardSnapshot();
    const state = {
      ...createInitialTuiState({
        initialSnapshot: snapshot,
        terminalRows: 20,
        dashboardFocus: {
          rowId: dashboardRowIds.session("ses_wt_web_working"),
          cellId: "identity",
        },
      }),
      screen: { name: "renameSession" as const, step: "chooseSlot" as const },
    };
    const committed: string[] = [];
    const commit = (current: typeof state, rowId: string) => {
      committed.push(rowId);
      return { state: current };
    };

    handleDashboardRowChoiceKey(state, { input: "\r", return: true }, commit);
    handleDashboardRowChoiceKey(state, { input: "1" }, commit);
    expect(committed).toEqual(["ses_wt_web_working", "ses_wt_web_working"]);
  });

  it("uses wheel input only to pan the viewport", () => {
    const snapshot = createDashboardSnapshot();
    const state = {
      ...createInitialTuiState({ initialSnapshot: snapshot, terminalRows: 10 }),
      screen: { name: "fork" as const, step: "chooseSlot" as const },
      dashboardFocus: {
        rowId: dashboardRowIds.session("ses_wt_web_working"),
        cellId: "identity" as const,
      },
    };

    const moved = handleDashboardRowChoiceKey(
      state,
      { input: "", mouseScroll: "down" },
      (current) => ({ state: current }),
    ).state;
    expect(moved.scrollOffset).toBe(1);
    expect(moved.dashboardFocus).toEqual(state.dashboardFocus);
  });

  it("skips Group headers while preserving grouped session slots", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = {
      ...createInitialTuiState({
        initialSnapshot: snapshot,
        terminalRows: 30,
        dashboardFocus: {
          rowId: dashboardRowIds.group("group_active"),
          cellId: "identity" as const,
        },
      }),
      screen: { name: "renameSession" as const, step: "chooseSlot" as const },
    };
    const committed: string[] = [];
    const moved = handleDashboardRowChoiceKey(
      state,
      { input: "", downArrow: true },
      (current, rowId) => {
        committed.push(rowId);
        return { state: current };
      },
    ).state;

    expect(moved.dashboardFocus).toEqual({
      rowId: dashboardRowIds.session("ses_wt_web_attention"),
      cellId: "identity",
    });
    handleDashboardRowChoiceKey(moved, { input: "1" }, (current, rowId) => {
      committed.push(rowId);
      return { state: current };
    });
    expect(committed).toEqual(["ses_wt_web_attention"]);
  });
});
