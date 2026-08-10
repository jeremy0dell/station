import { describe, expect, it } from "vitest";
import { dashboardRowIds } from "../../../src/selectors/dashboardTree.js";
import { selectDashboardViewport } from "../../../src/selectors/dashboardViewport.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard viewport selector", () => {
  it("clips projected rows and reports terminal hidden counts", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({ initialSnapshot: snapshot, scrollOffset: 1, terminalRows: 10 }),
    );

    expect(viewport.bodyRows).toBe(3);
    expect(viewport.clampedScrollOffset).toBe(1);
    expect(viewport.hiddenAbove).toBe(1);
    expect(viewport.hiddenBelow).toBe(6);
    expect(viewport.rows.map((row) => row.id)).toEqual([
      "session:ses_wt_web_working",
      "session:ses_wt_web_attention",
      "session:ses_wt_web_exited",
    ]);
  });

  it("passes through the full tree lookup while collapse clips descendants", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        terminalRows: 20,
        collapsedProjectIds: ["web"],
      }),
    );

    const hiddenId = dashboardRowIds.session("ses_wt_web_idle");
    expect(viewport.rows.map((row) => row.id)).not.toContain(hiddenId);
    expect(viewport.rowById.has(hiddenId)).toBe(true);
  });

  it("uses canonical sessions in the clipped window for continuous slots", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({ initialSnapshot: snapshot, scrollOffset: 4, terminalRows: 10 }),
    );

    expect(viewport.rowChoices.map((choice) => [choice.key, choice.value.id])).toEqual([
      ["1", "ses_wt_web_idle"],
      ["2", "ses_wt_web_unknown"],
      ["3", "ses_wt_web_stuck"],
    ]);
  });

  it("keeps pending-start sessions displayable but not actionable", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
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
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.displayRowChoices.map((choice) => choice.value.id)).toContain(
      "ses_wt_web_working",
    );
    expect(viewport.rowChoices.map((choice) => choice.value.id)).not.toContain(
      "ses_wt_web_working",
    );
  });

  it("removes pending-remove sessions from both choice lists", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
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
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.displayRowChoices.map((choice) => choice.value.id)).not.toContain(
      "ses_wt_web_working",
    );
    expect(viewport.rowChoices).toEqual(viewport.displayRowChoices);
  });

  it("reports session-like overflow independently of project chrome", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({ initialSnapshot: snapshot, terminalRows: 10 }),
    );

    expect(viewport.sessionOverflow).toEqual({
      above: 0,
      below: 5,
      visible: 2,
      total: 7,
    });
  });

  it("continues counting optimistic rows for overflow without assigning slots", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      terminalRows: 20,
      localRows: {
        pendingCreate: [
          {
            localId: "local_create_1",
            projectId: "web",
            title: "Hexagonal PT 12",
            branch: "feature/pending",
            harnessProvider: "codex",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });
    const viewport = selectDashboardViewport(snapshot, state);

    expect(viewport.sessionOverflow.total).toBe(8);
    expect(viewport.rows.map((row) => row.id)).toContain("create:local_create_1");
    expect(viewport.rowChoices.map((choice) => choice.value.worktree.branch)).not.toContain(
      "feature/pending",
    );
  });

  it("clamps offsets against full visible tree order", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({ initialSnapshot: snapshot, scrollOffset: 100, terminalRows: 10 }),
    );

    expect(viewport.clampedScrollOffset).toBe(7);
    expect(viewport.rows.at(-1)?.id).toBe("session:ses_wt_api_working");
  });

  it("passes through applied filter projection and filtered rows", () => {
    const snapshot = createDashboardSnapshot();
    const viewport = selectDashboardViewport(
      snapshot,
      createInitialTuiState({
        initialSnapshot: snapshot,
        terminalRows: 20,
        persistentFilter: { query: "api" },
      }),
    );

    expect(viewport.rows.map((row) => row.id)).toEqual([
      "project:api",
      "session:ses_wt_api_working",
    ]);
    expect(viewport.persistentFilter).toMatchObject({ source: "applied", active: true });
  });
});
