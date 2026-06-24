import { isRunningAgentState } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  assertSessionCloseAllowed,
  assertWorktreeRemovalAllowed,
  buildStationSnapshot,
  resolveSessionOrThrow,
  resolveWorktreeRowOrThrow,
} from "../../src/internal";
import { observerHarnessRunFromRun } from "../../src/reconcile/harnessEventStatus";

const now = "2026-05-21T12:00:00.000Z";

describe("cleanup command validation", () => {
  it("classifies active and exited agent states for cleanup guards", () => {
    expect(isRunningAgentState("starting")).toBe(true);
    expect(isRunningAgentState("idle")).toBe(true);
    expect(isRunningAgentState("working")).toBe(true);
    expect(isRunningAgentState("needs_attention")).toBe(true);
    expect(isRunningAgentState("stuck")).toBe(true);
    expect(isRunningAgentState("unknown")).toBe(true);
    expect(isRunningAgentState("exited")).toBe(false);
    expect(isRunningAgentState("none")).toBe(false);
    expect(isRunningAgentState(undefined)).toBe(false);
  });

  it("rejects dirty worktree removal unless force is explicit", () => {
    const snapshot = snapshotFor({ dirty: true, state: "none" });
    const row = snapshot.rows[0];

    expect(() => assertWorktreeRemovalAllowed(row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_DIRTY_REQUIRES_FORCE",
        worktreeId: "wt_web_cleanup",
      }),
    );
    expect(() => assertWorktreeRemovalAllowed(row, true)).not.toThrow();
  });

  it("rejects active-agent worktree removal and session close unless force is explicit", () => {
    const snapshot = snapshotFor({ dirty: false, state: "working" });
    const row = snapshot.rows[0];
    const session = snapshot.sessions[0];

    expect(() => assertWorktreeRemovalAllowed(row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_AGENT_ACTIVE_REQUIRES_FORCE",
        sessionId: "ses_web_cleanup",
      }),
    );
    expect(() => assertSessionCloseAllowed(session, row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "SESSION_AGENT_ACTIVE_REQUIRES_FORCE",
        sessionId: "ses_web_cleanup",
      }),
    );
    expect(() => assertWorktreeRemovalAllowed(row, true)).not.toThrow();
    expect(() => assertSessionCloseAllowed(session, row, true)).not.toThrow();
  });

  it("throws SafeErrors for missing session and worktree resolution", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });

    expect(() => resolveSessionOrThrow(snapshot, "ses_missing")).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "SESSION_NOT_FOUND",
        sessionId: "ses_missing",
      }),
    );
    expect(() => resolveWorktreeRowOrThrow(snapshot, "wt_missing")).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_NOT_FOUND",
        worktreeId: "wt_missing",
      }),
    );
  });
});

function snapshotFor(input: { dirty: boolean; state: "none" | "working" }) {
  const worktree = createFakeWorktree({
    id: "wt_web_cleanup",
    projectId: "web",
    branch: "cleanup",
    dirty: input.dirty,
    now,
  });
  return buildStationSnapshot({
    generatedAt: now,
    observer: {
      pid: 4242,
      startedAt: now,
      version: "0.0.0",
    },
    projects: [project],
    worktreeProviderId: "fake-worktree",
    providerHealth: {},
    worktrees: [worktree],
    terminalTargets:
      input.state === "none"
        ? []
        : [
            createFakeTerminalTarget({
              id: "term_web_cleanup",
              projectId: "web",
              worktreeId: "wt_web_cleanup",
              sessionId: "ses_web_cleanup",
              harnessRunId: "run_web_cleanup",
              now,
            }),
          ],
    harnessRuns:
      input.state === "none"
        ? []
        : [
            observerHarnessRunFromRun(
              createFakeHarnessRun({
                id: "run_web_cleanup",
                projectId: "web",
                worktreeId: "wt_web_cleanup",
                sessionId: "ses_web_cleanup",
                state: "working",
                now,
              }),
            ),
          ],
  });
}

const project = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
  },
};
