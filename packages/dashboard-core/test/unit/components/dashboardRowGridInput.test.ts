import { describe, expect, it } from "vitest";
import { dashboardRowGridInput } from "../../../src/components/Dashboard/rowGridInput.js";
import { dashboardRowIds, selectDashboardTree } from "../../../src/selectors/dashboardTree.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard row-grid input", () => {
  it("preserves the canonical row-grid shape and slot", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const row = requiredRow(tree, dashboardRowIds.session("ses_wt_web_working"));

    expect(dashboardRowGridInput(row, new Map([["ses_wt_web_working", "1"]]))).toMatchObject({
      id: "session:ses_wt_web_working",
      cells: {
        identity: {
          segments: expect.arrayContaining([expect.objectContaining({ text: "[1] " })]),
        },
        title: { segments: [{ kind: "text", text: "cache-refactor" }] },
      },
    });
  });

  it("uses operation presentation for pending start and remove rows", () => {
    const snapshot = createDashboardSnapshot();
    const baseLocalRows = {
      pendingCreate: [],
      failedCreate: [],
      pendingRemove: [],
      pendingStart: [],
    };
    const pendingStart = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        ...baseLocalRows,
        pendingStart: [
          {
            localId: "start:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            operation: "resumeAgent",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    });
    const startTree = selectDashboardTree(snapshot, pendingStart, pendingStart.screen);
    const startRow = requiredRow(startTree, dashboardRowIds.session("ses_wt_web_working"));
    expect(dashboardRowGridInput(startRow, new Map([["ses_wt_web_working", "1"]]))).toMatchObject({
      cells: {
        identity: { segments: expect.arrayContaining([expect.objectContaining({ text: "[1] " })]) },
        activity: { segments: [expect.objectContaining({ text: "resuming..." })] },
      },
    });

    const pendingRemove = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        ...baseLocalRows,
        pendingRemove: [
          {
            localId: "remove:wt_web_working",
            projectId: "web",
            worktreeId: "wt_web_working",
            branch: "fix-dashboard-refresh",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
      },
    });
    const removeTree = selectDashboardTree(snapshot, pendingRemove, pendingRemove.screen);
    const removeRow = requiredRow(removeTree, dashboardRowIds.session("ses_wt_web_working"));
    expect(dashboardRowGridInput(removeRow, new Map())).toMatchObject({
      cells: {
        identity: {
          segments: expect.not.arrayContaining([expect.objectContaining({ text: "1" })]),
        },
        activity: { segments: [expect.objectContaining({ text: "removing session..." })] },
      },
    });
  });

  it("renders pending and failed optimistic rows without slots", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      localRows: {
        pendingCreate: [
          {
            localId: "pending",
            projectId: "web",
            title: "Pending launch",
            branch: "pending-launch",
            harnessProvider: "codex",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [
          {
            localId: "failed",
            projectId: "web",
            title: "Failed launch",
            branch: "failed-launch",
            error: { tag: "ClientObserverError", code: "FAILED", message: "Launch failed." },
            expiresAt: Date.now() + 4_000,
          },
        ],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(
      dashboardRowGridInput(requiredRow(tree, dashboardRowIds.create("pending")), new Map()),
    ).toMatchObject({
      cells: {
        title: { segments: [{ kind: "text", text: "Pending launch" }] },
        activity: { segments: [expect.objectContaining({ text: "starting session..." })] },
      },
    });
    expect(
      dashboardRowGridInput(requiredRow(tree, dashboardRowIds.create("failed")), new Map()),
    ).toMatchObject({
      cells: {
        identity: { segments: expect.arrayContaining([expect.objectContaining({ text: "!" })]) },
        activity: { segments: [expect.objectContaining({ text: "Launch failed." })] },
      },
    });
  });

  it("reads focus directly from the projected row", () => {
    const snapshot = createDashboardSnapshot();
    const rowId = dashboardRowIds.session("ses_wt_web_working");
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      dashboardFocus: { rowId, cellId: "identity" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(
      dashboardRowGridInput(requiredRow(tree, rowId), new Map())?.cells.identity.segments[0],
    ).toMatchObject({ kind: "text", text: "▏" });
  });

  it("owns persistent-filter highlighting and dimming", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      persistentFilter: { query: "slow-tests" },
    });
    const tree = selectDashboardTree(snapshot, state, state.screen);
    const matched = dashboardRowGridInput(
      requiredRow(tree, dashboardRowIds.session("ses_wt_web_stuck")),
      new Map(),
    );

    expect(matched?.cells.title.segments).toEqual([
      expect.objectContaining({ text: "slow-tests", highlighted: true }),
    ]);
    expect(matched?.cells.title.segments[0]).not.toMatchObject({ dimmed: true });
  });

  it("returns no grid input for structural rows", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const tree = selectDashboardTree(snapshot, state, state.screen);

    expect(
      dashboardRowGridInput(requiredRow(tree, dashboardRowIds.project("web")), new Map()),
    ).toBeUndefined();
  });
});

function requiredRow(
  tree: ReturnType<typeof selectDashboardTree>,
  rowId: ReturnType<(typeof dashboardRowIds)[keyof typeof dashboardRowIds]>,
) {
  const row = tree.rowById.get(rowId);
  if (row === undefined) throw new Error(`missing row ${rowId}`);
  return row;
}
