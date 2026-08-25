import { describe, expect, it } from "vitest";
import {
  selectDashboardSlots,
  selectDashboardSlotsForTree,
} from "../../../src/selectors/dashboardSlots.js";
import { dashboardRowIds, selectDashboardTree } from "../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import {
  createDashboardSnapshot,
  createGroupedDashboardSnapshot,
} from "../../fixtures/snapshots.js";

describe("dashboard semantic slots", () => {
  it("derives a new renderer visibility window from an existing semantic tree", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const slots = selectDashboardSlotsForTree(tree, [
      dashboardRowIds.session("ses_wt_web_idle"),
      dashboardRowIds.session("ses_wt_web_unknown"),
    ]);

    expect(slots.tree).toBe(tree);
    expect(slots.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "ses_wt_web_idle"],
      ["2", "ses_wt_web_unknown"],
    ]);
  });

  it("assigns continuous keys to renderer-visible session identities", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const slots = selectDashboardSlots(snapshot, state, state.screen, [
      dashboardRowIds.project("web"),
      dashboardRowIds.session("ses_wt_web_idle"),
      dashboardRowIds.session("ses_wt_web_unknown"),
      dashboardRowIds.session("ses_wt_web_stuck"),
    ]);

    expect(slots.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "ses_wt_web_idle"],
      ["2", "ses_wt_web_unknown"],
      ["3", "ses_wt_web_stuck"],
    ]);
  });

  it("assigns continuous visible-session slots across Group containers", () => {
    const snapshot = createGroupedDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const slots = selectDashboardSlots(snapshot, state, state.screen, [
      dashboardRowIds.session("ses_wt_web_idle"),
      dashboardRowIds.group("group_build"),
      dashboardRowIds.session("ses_wt_web_working"),
      dashboardRowIds.session("ses_wt_web_exited"),
    ]);

    expect(slots.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "ses_wt_web_idle"],
      ["2", "ses_wt_web_working"],
      ["3", "ses_wt_web_exited"],
    ]);
  });

  it("keeps pending-start sessions displayable but not actionable", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
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
    const slots = selectDashboardSlots(snapshot, state, state.screen, [
      dashboardRowIds.session("ses_wt_web_working"),
    ]);

    expect(slots.displayRowChoices.map((choice) => choice.value.id)).toEqual([
      "ses_wt_web_working",
    ]);
    expect(slots.rowChoices).toEqual([]);
  });

  it("removes pending-remove sessions from both choice lists", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [
          {
            localId: "remove:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            branch: "fix-dashboard-refresh",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        pendingStart: [],
      },
    });
    const slots = selectDashboardSlots(snapshot, state, state.screen, [
      dashboardRowIds.session("ses_wt_web_working"),
    ]);

    expect(slots.displayRowChoices).toEqual([]);
    expect(slots.rowChoices).toEqual([]);
  });

  it("reports session overflow around semantic identities rather than item counts", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const slots = selectDashboardSlots(snapshot, state, state.screen, [
      dashboardRowIds.session("ses_wt_web_exited"),
      dashboardRowIds.session("ses_wt_web_idle"),
    ]);

    expect(slots.sessionOverflow).toEqual({ above: 2, below: 3, visible: 2, total: 7 });
  });

  it("uses the full semantic projection until a renderer reports visibility", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const slots = selectDashboardSlots(snapshot, state, state.screen);

    expect(slots.rowChoices).toHaveLength(7);
    expect(slots.sessionOverflow).toEqual({ above: 0, below: 0, visible: 7, total: 7 });
  });

  it("keeps a measured empty viewport distinct from unmeasured visibility", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const slots = selectDashboardSlots(snapshot, state, state.screen, []);

    expect(slots.rowChoices).toEqual([]);
    expect(slots.displayRowChoices).toEqual([]);
    expect(slots.sessionOverflow).toEqual({ above: 0, below: 7, visible: 0, total: 7 });
  });

  it("passes through applied filter projection without fabricating layout nodes", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "api" },
    });
    const slots = selectDashboardSlots(snapshot, state, state.screen);

    expect(slots.tree.visibleRows.map((row) => row.id)).toEqual([
      "project:web",
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(slots.persistentFilter).toMatchObject({ source: "applied", active: true });
  });
});
