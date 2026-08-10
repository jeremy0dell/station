import type { HarnessRunObservation } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  normalizeHarnessRunsForCurrentWorktrees,
  normalizeTerminalTargetsForCurrentWorktrees,
  resolveWorktreeByProjectPath,
} from "../../src/reconcile/observationCorrelation";
import { observerHarnessRunFromRun } from "../support/harnessRuns";

const now = "2026-06-19T12:00:00.000Z";

describe("reconcile observation correlation", () => {
  it("prefers an unambiguous cwd match over a stale claimed terminal worktree id", () => {
    const worktrees = [
      createFakeWorktree({ id: "wt_current", path: "/tmp/station/web/task" }),
      createFakeWorktree({ id: "wt_stale", path: "/tmp/station/web/old-task" }),
    ];
    const target = createFakeTerminalTarget({
      id: "term_1",
      projectId: "web",
      worktreeId: "wt_stale",
      cwd: "/tmp/station/web/task/src",
      now,
    });

    expect(
      normalizeTerminalTargetsForCurrentWorktrees({
        terminalTargets: [target],
        worktrees,
      }),
    ).toEqual([{ ...target, worktreeId: "wt_current" }]);
  });

  it("uses cwd precedence for harness runs before terminal and claimed-id fallbacks", () => {
    const worktrees = [
      createFakeWorktree({ id: "wt_current", path: "/tmp/station/web/task" }),
      createFakeWorktree({ id: "wt_stale", path: "/tmp/station/web/old-task" }),
    ];
    const run = createFakeHarnessRun({
      id: "run_1",
      projectId: "web",
      worktreeId: "wt_stale",
      sessionId: "session_1",
      cwd: "/tmp/station/web/task/src",
      now,
    });
    const terminal = createFakeTerminalTarget({
      id: "term_1",
      projectId: "web",
      worktreeId: "wt_stale",
      sessionId: "session_1",
      now,
    });

    expect(
      normalizeHarnessRunsForCurrentWorktrees({
        harnessRuns: [observerHarnessRunFromRun(run)],
        worktrees,
        terminalTargets: [terminal],
      })[0]?.run,
    ).toEqual({ ...run, worktreeId: "wt_current" });
  });

  it("leaves missing and ambiguous path matches unchanged", () => {
    const missingWorktree = createFakeWorktree({ id: "wt_current", path: "/tmp/station/web/task" });
    const ambiguousPath = "/tmp/station/web/shared";
    const ambiguousWorktrees = [
      createFakeWorktree({ id: "wt_a", path: ambiguousPath }),
      createFakeWorktree({ id: "wt_b", path: ambiguousPath }),
    ];

    expect(
      resolveWorktreeByProjectPath({
        projectId: "web",
        cwd: "/tmp/station/web/unknown",
        worktrees: [missingWorktree],
      }),
    ).toBeUndefined();
    expect(
      resolveWorktreeByProjectPath({
        projectId: "web",
        cwd: `${ambiguousPath}/src`,
        worktrees: ambiguousWorktrees,
      }),
    ).toBeUndefined();

    const target = createFakeTerminalTarget({
      id: "term_1",
      projectId: "web",
      worktreeId: "wt_missing",
      cwd: `${ambiguousPath}/src`,
      now,
    });
    expect(
      normalizeTerminalTargetsForCurrentWorktrees({
        terminalTargets: [target],
        worktrees: ambiguousWorktrees,
      }),
    ).toEqual([target]);
  });

  it("does not replace a harness run when cwd has no current worktree", () => {
    const run: HarnessRunObservation = createFakeHarnessRun({
      id: "run_1",
      projectId: "web",
      worktreeId: "wt_missing",
      cwd: "/tmp/station/web/unknown",
      now,
    });

    expect(
      normalizeHarnessRunsForCurrentWorktrees({
        harnessRuns: [observerHarnessRunFromRun(run)],
        worktrees: [createFakeWorktree({ id: "wt_current", path: "/tmp/station/web/task" })],
        terminalTargets: [],
      }),
    ).toEqual([observerHarnessRunFromRun(run)]);
  });
});
