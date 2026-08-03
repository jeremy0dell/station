import { createInitialTuiState } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import {
  persistentFilterCandidateForDashboardRow,
  selectDashboardProjectRowGroups,
} from "../../../src/selectors/dashboardProjectRows.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("dashboard project rows", () => {
  it("composes canonical and optimistic rows with render-ready presentation", () => {
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
        ],
        failedCreate: [],
        pendingRemove: [
          {
            localId: "remove:wt_web_idle",
            projectId: "web",
            worktreeId: "wt_web_idle",
            branch: "fix-nav-mobile",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        pendingStart: [],
      },
    });

    const web = selectDashboardProjectRowGroups(titled, state, {
      applyLegacySearch: false,
    }).find((group) => group.project.id === "web");

    expect(web?.rows.slice(0, 3).map((row) => row.id)).toEqual([
      "session:ses_wt_web_stuck",
      "create:local_create_1",
      "session:ses_wt_web_working",
    ]);
    expect(web?.rows.find((row) => row.id === "create:local_create_1")).toMatchObject({
      type: "createLocalRow",
      presentation: {
        title: "bbb pending task",
        agent: "codex",
        activity: "starting session...",
      },
    });
    expect(web?.rows.find((row) => row.id === "session:ses_wt_web_idle")).toMatchObject({
      type: "session",
      presentation: { activity: "removing session..." },
      pendingRemove: { localId: "remove:wt_web_idle" },
    });
  });

  it("preserves complete row composition behind stored collapse", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      collapsedProjectIds: ["web"],
    });

    const web = selectDashboardProjectRowGroups(snapshot, state, {
      applyLegacySearch: false,
    }).find((group) => group.project.id === "web");

    expect(web?.collapsed).toBe(true);
    expect(web?.rows.map((row) => row.id)).toContain("session:ses_wt_web_idle");
  });

  it("keeps legacy hidden-field search outside the visible filter candidate", () => {
    const snapshot = createDashboardSnapshot();
    const state = createInitialTuiState({
      initialSnapshot: snapshot,
      searchQuery: "e91f2b",
      localRows: {
        pendingCreate: [
          {
            localId: "local_hidden_branch",
            projectId: "web",
            title: "Readable pending task",
            branch: "station-e91f2b",
            createdAt: "2026-05-31T12:00:00.000Z",
          },
        ],
        failedCreate: [],
        pendingRemove: [],
        pendingStart: [],
      },
    });

    const row = selectDashboardProjectRowGroups(snapshot, state, {
      applyLegacySearch: true,
    })
      .flatMap((group) => group.rows)
      .find((candidate) => candidate.id === "create:local_hidden_branch");
    if (row === undefined) throw new Error("legacy branch search did not retain optimistic row");

    expect(persistentFilterCandidateForDashboardRow(row)).toEqual({
      kind: "optimistic",
      id: "create:local_hidden_branch",
      projectId: "web",
      visibleFields: {
        title: "Readable pending task",
        agent: "",
        activity: "starting session...",
      },
    });
  });
});
