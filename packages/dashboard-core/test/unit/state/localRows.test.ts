import {
  addPendingStartAgentRow,
  bindPendingStartAgentRow,
  createEmptyTuiLocalRows,
  createInitialTuiState,
  pruneLocalRowsForSnapshot,
  removePendingStartAgentRow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot } from "../../fixtures/snapshots.js";

describe("TUI local rows", () => {
  it("adds, binds, and removes pending start-agent rows", () => {
    const state = addPendingStartAgentRow(createInitialTuiState(), {
      localId: "start:wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    const bound = bindPendingStartAgentRow(state, "start:wt_web_no_agent", "cmd_start_1");
    expect(bound.localRows.pendingStart).toEqual([
      {
        localId: "start:wt_web_no_agent",
        projectId: "web",
        worktreeId: "wt_web_no_agent",
        branch: "feature-start",
        createdAt: "2026-06-01T12:00:00.000Z",
        commandId: "cmd_start_1",
      },
    ]);

    expect(
      removePendingStartAgentRow(bound, "start:wt_web_no_agent").localRows.pendingStart,
    ).toEqual([]);
  });

  it("prunes pending start-agent rows when snapshot truth has an agent", () => {
    const localRows = {
      ...createEmptyTuiLocalRows(),
      pendingStart: [
        {
          localId: "start:wt_web_idle",
          projectId: "web",
          worktreeId: "wt_web_idle",
          branch: "fix-nav-mobile",
          createdAt: "2026-06-01T12:00:00.000Z",
        },
      ],
    };

    expect(
      pruneLocalRowsForSnapshot(localRows, createCommandSnapshot("idle")).pendingStart,
    ).toEqual([]);
  });

  it("keeps pending start-agent rows while the worktree still has no agent", () => {
    const localRows = {
      ...createEmptyTuiLocalRows(),
      pendingStart: [
        {
          localId: "start:wt_web_no_agent",
          projectId: "web",
          worktreeId: "wt_web_no_agent",
          branch: "feature-start",
          createdAt: "2026-06-01T12:00:00.000Z",
        },
      ],
    };

    expect(
      pruneLocalRowsForSnapshot(localRows, createCommandSnapshot("none")).pendingStart,
    ).toEqual(localRows.pendingStart);
  });
});
