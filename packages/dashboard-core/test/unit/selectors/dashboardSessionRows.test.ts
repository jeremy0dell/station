import type { TuiViewState } from "@station/dashboard-core";
import { createInitialTuiState } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import {
  selectDashboardSessionRows,
  selectProjectGroups,
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
} from "../../../src/selectors/dashboardSessionRows.js";
import { createDashboardSnapshot, createExternalAgentSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard session rows", () => {
  it("projects canonical sessions instead of bare worktrees", () => {
    const snapshot = createDashboardSnapshot();
    const rows = selectDashboardSessionRows(snapshot);

    expect(rows.map((row) => row.id)).toContain("ses_wt_web_idle");
    expect(rows.map((row) => row.id)).not.toContain("wt_web_no_agent");
    expect(rows.find((row) => row.id === "ses_wt_web_attention")?.presentation).toMatchObject({
      display: {
        statusLabel: "needs attention",
        alert: true,
      },
      agent: {
        state: "needs_attention",
      },
    });
  });

  it("owns project grouping, ordering, and stored collapse", () => {
    const snapshot = createDashboardSnapshot();
    const state: TuiViewState = {
      ...createInitialTuiState({ initialSnapshot: snapshot }),
      collapsedProjectIds: new Set(["web"]),
    };

    expect(
      selectProjectGroups(snapshot, state)
        .flatMap((group) => group.rows)
        .map((candidate) => candidate.id),
    ).toEqual(["ses_wt_api_working"]);
    const complete = selectProjectGroups(snapshot, state, {
      includeCollapsedRows: true,
    });
    expect(complete.find((group) => group.project.id === "web")).toMatchObject({
      collapsed: true,
      rows: [
        expect.objectContaining({ id: "ses_wt_web_working" }),
        expect.objectContaining({ id: "ses_wt_web_attention" }),
        expect.objectContaining({ id: "ses_wt_web_exited" }),
        expect.objectContaining({ id: "ses_wt_web_idle" }),
        expect.objectContaining({ id: "ses_wt_web_unknown" }),
        expect.objectContaining({ id: "ses_wt_web_stuck" }),
      ],
    });
  });

  it("resolves optimistic title overrides at the session-row boundary", () => {
    const snapshot = createDashboardSnapshot();
    const row = selectDashboardSessionRows(snapshot).find(
      (candidate) => candidate.id === "ses_wt_web_idle",
    );
    if (row === undefined) throw new Error("missing fixture session row");

    expect(
      sessionRowDisplayTitle(row, {
        pendingCreate: [],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
        pendingRenameTitles: {
          ses_wt_web_idle: {
            sessionId: "ses_wt_web_idle",
            title: "Optimistic readable title",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        },
      }),
    ).toBe("Optimistic readable title");
  });

  it("prefers external run identity over retained worktree membership", () => {
    const external = createExternalAgentSnapshot();
    const station = createDashboardSnapshot();
    const row = external.rows.find((candidate) => candidate.id === "wt_web_idle");
    const retained = station.sessions.find((session) => session.worktreeId === row?.id);
    if (row === undefined || retained === undefined) throw new Error("missing fixture membership");

    expect(sessionForWorktreeRow(row, [retained, ...external.sessions])).toMatchObject({
      origin: "external",
      id: row.agent?.runId,
    });
  });
});
