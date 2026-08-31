import { describe, expect, it } from "vitest";
import {
  selectDashboardSessionRows,
  sessionForWorktreeRow,
  sessionRowDisplayTitle,
} from "../../../src/selectors/dashboardSessionRows.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createDashboardSnapshot, createExternalAgentSnapshot } from "../../fixtures/snapshots.js";

const STATUS_DISPLAYS = {
  needs_attention: { statusLabel: "needs attention", sortPriority: 10, alert: true },
  stuck: { statusLabel: "stuck", sortPriority: 20, alert: true, warning: true },
  working: { statusLabel: "working", sortPriority: 30, alert: false },
  starting: { statusLabel: "starting", sortPriority: 35, alert: false },
  idle: { statusLabel: "idle", sortPriority: 40, alert: false },
  unknown: { statusLabel: "unknown", sortPriority: 50, alert: false },
  exited: { statusLabel: "exited", sortPriority: 60, alert: false },
  none: { statusLabel: "no agent", sortPriority: 70, alert: false },
} as const;

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

  it("projects every session state with its contextual reason", () => {
    const base = createDashboardSnapshot();
    const sourceRow = base.rows[0];
    const sourceSession = base.sessions[0];
    if (sourceRow === undefined || sourceSession === undefined) {
      throw new Error("missing fixture session");
    }

    for (const [state, expectedDisplay] of Object.entries(STATUS_DISPLAYS)) {
      const reason = `Context for ${state}.`;
      const snapshot = {
        ...base,
        rows: [sourceRow],
        sessions: [
          {
            ...sourceSession,
            status: { ...sourceSession.status, value: state, reason },
          },
        ],
      } as typeof base;

      expect(selectDashboardSessionRows(snapshot)[0]?.presentation.display).toEqual({
        ...expectedDisplay,
        reason,
      });
    }
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

  it("resolves canonical row titles", () => {
    const snapshot = createDashboardSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === "ses_wt_web_idle");
    const worktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_idle");
    if (session === undefined || worktree === undefined) throw new Error("missing fixture session");
    const titledWorktree = { ...worktree, title: "Readable feature task" };

    expect(
      sessionRowDisplayTitle(
        { session, worktree: titledWorktree },
        createInitialTuiState().localRows,
      ),
    ).toBe("Readable feature task");
  });

  it("retains a canonical no-agent title through pending launch state", () => {
    const snapshot = createDashboardSnapshot();
    const worktree = snapshot.rows.find((candidate) => candidate.id === "wt_web_no_agent");
    const sourceSession = snapshot.sessions[0];
    if (worktree === undefined || sourceSession === undefined) {
      throw new Error("missing retained no-agent fixture inputs");
    }
    const session = { ...sourceSession, id: "ses_retained_no_agent", worktreeId: worktree.id };

    expect(
      sessionRowDisplayTitle(
        { session, worktree: { ...worktree, title: "Durable no-agent workspace" } },
        {
          pendingCreate: [],
          failedCreate: [],
          pendingRemove: [],
          pendingStart: [
            {
              localId: "start-retained",
              operation: "resumeAgent",
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              branch: worktree.branch,
              createdAt: "2026-05-31T12:00:00.000Z",
            },
          ],
        },
      ),
    ).toBe("Durable no-agent workspace");
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
