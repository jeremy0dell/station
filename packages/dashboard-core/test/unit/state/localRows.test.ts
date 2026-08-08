import { describe, expect, it } from "vitest";
import {
  addPendingCreateSessionRow,
  addPendingStartAgentRow,
  createEmptyTuiLocalRows,
  failPendingCreateSessionRow,
  pruneLocalRowsForSnapshot,
  removePendingStartAgentRow,
} from "../../../src/state/localRows.js";
import { createInitialTuiState } from "../../../src/state/screen.js";
import { createCommandSnapshot } from "../../fixtures/snapshots.js";

describe("TUI local rows", () => {
  it("atomically replaces the matching pending create row with a failed row", () => {
    const pending = addPendingCreateSessionRow(createInitialTuiState(), {
      localId: "create:web:feature-failed",
      projectId: "web",
      title: "Failed launch",
      branch: "feature-failed",
      createdAt: "2026-06-01T12:00:00.000Z",
    });
    const error = {
      tag: "ClientObserverError" as const,
      code: "PREPARE_FAILED",
      message: "Harness preparation failed.",
    };

    const failed = failPendingCreateSessionRow(pending, "create:web:feature-failed", error, 1234);

    expect(failed.localRows.pendingCreate).toEqual([]);
    expect(failed.localRows.failedCreate).toEqual([
      {
        localId: "create:web:feature-failed",
        projectId: "web",
        title: "Failed launch",
        branch: "feature-failed",
        error,
        expiresAt: 1234,
      },
    ]);
  });

  it("adds and removes pending start-agent rows without retaining command identity", () => {
    const state = addPendingStartAgentRow(createInitialTuiState(), {
      localId: "start:wt_web_no_agent",
      projectId: "web",
      worktreeId: "wt_web_no_agent",
      branch: "feature-start",
      createdAt: "2026-06-01T12:00:00.000Z",
    });

    expect(state.localRows.pendingStart).toEqual([
      {
        localId: "start:wt_web_no_agent",
        projectId: "web",
        worktreeId: "wt_web_no_agent",
        branch: "feature-start",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ]);
    expect(state.localRows.pendingStart[0]).not.toHaveProperty("commandId");
    expect(
      removePendingStartAgentRow(state, "start:wt_web_no_agent").localRows.pendingStart,
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

  it("prunes pending start-agent rows when the retained session disappears", () => {
    const snapshot = createCommandSnapshot("none");
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
      pruneLocalRowsForSnapshot(localRows, { ...snapshot, sessions: [] }).pendingStart,
    ).toEqual([]);
  });
});
