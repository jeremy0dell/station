import { applyStationEvent } from "@station/client";
import type { StationEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, fixtureNow, row } from "../support/snapshots.js";

describe("client snapshot reducer", () => {
  it("applies direct worktree row updates without requesting a snapshot refresh", () => {
    const snapshot = createCommandSnapshot("idle");
    const event: StationEvent = {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        display: {
          statusLabel: "working",
          sortPriority: 30,
          alert: false,
          reason: "Harness reported active generation.",
        },
      },
    };

    const result = applyStationEvent(snapshot, event);
    expect(result.needsSnapshotRefresh).toBe(false);
    expect(result.snapshot.rows[0]?.display.statusLabel).toBe("working");
  });

  it("applies readiness-only worktree row updates", () => {
    const snapshot = createCommandSnapshot("idle");
    const rowAgent = snapshot.rows[0]?.agent;
    if (rowAgent === undefined) {
      throw new Error("Expected idle fixture row to have an agent.");
    }
    const added = applyStationEvent(snapshot, {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        agent: {
          ...rowAgent,
          turnReadiness: {
            state: "ready_to_read",
            token: "report_ready",
            completedAt: fixtureNow,
          },
        },
      },
    });

    expect(added.needsSnapshotRefresh).toBe(false);
    expect(added.snapshot.rows[0]?.agent?.turnReadiness).toEqual({
      state: "ready_to_read",
      token: "report_ready",
      completedAt: fixtureNow,
    });

    const removedAgent = { ...rowAgent };
    const removed = applyStationEvent(added.snapshot, {
      type: "worktree.updated",
      worktreeId: "wt_web_idle",
      patch: {
        agent: removedAgent,
      },
    });

    expect(removed.needsSnapshotRefresh).toBe(false);
    expect(removed.snapshot.rows[0]?.agent).not.toHaveProperty("turnReadiness");
  });

  it("adds and removes worktree rows from normalized events", () => {
    const snapshot = createCommandSnapshot("none");
    const added = applyStationEvent(snapshot, {
      type: "worktree.added",
      row: row({ id: "wt_web_added", projectId: "web", branch: "new-row", state: "none" }),
    });

    expect(added.snapshot.rows.map((candidate) => candidate.id)).toContain("wt_web_added");

    const removed = applyStationEvent(added.snapshot, {
      type: "worktree.removed",
      worktreeId: "wt_web_added",
    });
    expect(removed.snapshot.rows.map((candidate) => candidate.id)).not.toContain("wt_web_added");
  });

  it("updates row display from live agent state events", () => {
    const snapshot = createCommandSnapshot("idle");
    const result = applyStationEvent(snapshot, {
      type: "worktree.agentStateChanged",
      worktreeId: "wt_web_idle",
      agent: {
        harness: "codex",
        state: "needs_attention",
        runId: "run_wt_web_idle",
        sessionId: "ses_wt_web_idle",
        confidence: "high",
        reason: "Codex requested permission.",
        updatedAt: fixtureNow,
      },
    });

    expect(result.needsSnapshotRefresh).toBe(false);
    expect(result.snapshot.rows[0]?.agent?.state).toBe("needs_attention");
    expect(result.snapshot.rows[0]?.display).toMatchObject({
      statusLabel: "needs attention",
      alert: true,
      reason: "Codex requested permission.",
    });
  });

  it("turns command failures into safe diagnostic notices", () => {
    const snapshot = createCommandSnapshot("idle");
    const result = applyStationEvent(snapshot, {
      type: "command.failed",
      commandId: "cmd_focus_1",
      error: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        message: "The terminal target for this worktree no longer exists.",
        hint: "Refresh the dashboard or reopen the worktree.",
        diagnosticId: "diag_terminal_missing",
        traceId: "trc_terminal_missing",
      },
    });

    expect(result.notices).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "The terminal target for this worktree no longer exists.",
        diagnosticId: "diag_terminal_missing",
        traceId: "trc_terminal_missing",
      }),
    ]);
  });

  it("requests snapshot refresh after reconcile and provider health events", () => {
    const snapshot = createCommandSnapshot("idle");
    const reconciled = applyStationEvent(snapshot, {
      type: "observer.reconciled",
      at: fixtureNow,
      changed: 1,
    });
    const provider = applyStationEvent(snapshot, {
      type: "provider.healthChanged",
      provider: "tmux",
      health: {
        providerId: "tmux",
        providerType: "terminal",
        status: "healthy",
        lastCheckedAt: fixtureNow,
      },
    });

    expect(reconciled.needsSnapshotRefresh).toBe(true);
    expect(provider.needsSnapshotRefresh).toBe(true);
  });
});
