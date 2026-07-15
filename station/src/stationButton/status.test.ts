import { describe, expect, it } from "bun:test";
import {
  createInitialTuiState,
  selectDashboardSessionRows,
  selectFleetSummary,
} from "@station/dashboard-core";
import {
  attentionAndFailuresSnapshot,
  manyProjectsSnapshot,
} from "../station/fixtures/scenarios.js";
import { selectStationButtonStatus, stationButtonStatusEqual } from "./status.js";

describe("selectStationButtonStatus", () => {
  it("is empty before a snapshot arrives", () => {
    expect(selectStationButtonStatus(createInitialTuiState())).toEqual({
      attention: false,
      needsYouCount: 0,
      workingCount: 0,
      readyCount: 0,
      idleCount: 0,
    });
  });

  it("reports the client-side fleet breakdown and no attention for a healthy snapshot", () => {
    const snapshot = manyProjectsSnapshot();
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));
    const fleet = selectFleetSummary(snapshot);

    expect(status.workingCount).toBe(fleet.working);
    expect(status.readyCount).toBe(fleet.ready);
    expect(status.idleCount).toBe(fleet.idle);
    // The classic totals stay intact: ready + idle covers the contract's idle count.
    expect(status.readyCount + status.idleCount).toBe(snapshot.counts.idle);
    expect(status.attention).toBe(false);
    expect(status.needsYouCount).toBe(0);
    expect(status.sessionName).toBeUndefined();
    expect(status.attentionWorktreeId).toBeUndefined();
    expect(status.projectRollup).toBeUndefined();
  });

  it("flags the first session needing the user and counts the queue", () => {
    const snapshot = attentionAndFailuresSnapshot();
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));
    const flagged = selectDashboardSessionRows(snapshot).filter(
      (row) => row.session.status.value === "needs_attention" || row.session.status.value === "stuck",
    );

    expect(status.attention).toBe(true);
    expect(status.needsYouCount).toBe(flagged.length);
    expect(status.attentionWorktreeId).toBe(flagged[0]?.worktree.id);
    expect(typeof status.sessionName).toBe("string");
  });

  it("alerts on a stuck session even though counts.attention excludes it", () => {
    const base = attentionAndFailuresSnapshot();
    const stuckRow = base.rows.find((row) => row.display.statusLabel === "stuck");
    if (stuckRow === undefined) {
      throw new Error("fixture is expected to contain a stuck row");
    }
    // A stuck-only snapshot: the observer's counts.attention is 0, but the
    // session still needs the user.
    const snapshot = { ...base, rows: [stuckRow], counts: { ...base.counts, attention: 0 } };
    const status = selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }));

    expect(status.attention).toBe(true);
    expect(status.needsYouCount).toBe(1);
    expect(status.attentionWorktreeId).toBe(stuckRow.id);
  });

  it("builds the per-project roll-up only when asked, keeping the worst status", () => {
    const snapshot = attentionAndFailuresSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const status = selectStationButtonStatus(state, { projectRollup: true });
    const rollup = status.projectRollup;
    if (rollup === undefined) {
      throw new Error("expected a roll-up when the option is on");
    }

    // One entry per project holding sessions, in row display order.
    const sessionRows = selectDashboardSessionRows(snapshot);
    const projectIds = [...new Set(sessionRows.map((row) => row.worktree.projectId))];
    expect(rollup.map((entry) => entry.projectId)).toEqual(projectIds);

    // A project with a flagged session rolls up to needsYou even when it also
    // has calmer sessions.
    const flagged = sessionRows.find(
      (row) => row.session.status.value === "needs_attention" || row.session.status.value === "stuck",
    );
    const flaggedEntry = rollup.find((entry) => entry.projectId === flagged?.worktree.projectId);
    expect(flaggedEntry?.status).toBe("needsYou");
  });

  it("does not include a bare worktree in button counts or project rollups", () => {
    const base = manyProjectsSnapshot();
    const bare = base.rows.find((row) => row.id === "wt_scripts_none");
    if (bare === undefined) throw new Error("fixture is expected to contain a bare worktree");
    const snapshot = {
      ...base,
      rows: [bare],
      sessions: [],
    };

    expect(
      selectStationButtonStatus(createInitialTuiState({ initialSnapshot: snapshot }), {
        projectRollup: true,
      }),
    ).toEqual({
      attention: false,
      needsYouCount: 0,
      workingCount: 0,
      readyCount: 0,
      idleCount: 0,
      projectRollup: [],
    });
  });

  it("compares field-wise so the snapshot reference can stay stable", () => {
    const snapshot = manyProjectsSnapshot();
    const state = createInitialTuiState({ initialSnapshot: snapshot });
    const a = selectStationButtonStatus(state, { projectRollup: true });
    const b = selectStationButtonStatus(state, { projectRollup: true });

    expect(stationButtonStatusEqual(a, b)).toBe(true);
    expect(stationButtonStatusEqual(a, { ...a, workingCount: a.workingCount + 1 })).toBe(false);
    // Roll-up presence and content participate in the comparison.
    expect(stationButtonStatusEqual(a, { ...a, projectRollup: undefined })).toBe(false);
    if (a.projectRollup !== undefined && a.projectRollup.length > 0) {
      const [first, ...rest] = a.projectRollup;
      if (first !== undefined) {
        expect(
          stationButtonStatusEqual(a, {
            ...a,
            projectRollup: [{ ...first, status: "needsYou" }, ...rest],
          }),
        ).toBe(a.projectRollup[0]?.status === "needsYou");
      }
    }
  });
});
