import type {
  AgentState,
  Confidence,
  HarnessEventReport,
  ObservedStatus,
} from "@station/contracts";
import { STATION_SCHEMA_VERSION } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { buildStationSnapshot } from "../../src/reconcile/graph";
import { observerHarnessRunFromRun } from "../../src/reconcile/harnessEventStatus";
import {
  projectHarnessEventReportOntoSnapshot,
  withWorktreeCorrelationFromCwd,
} from "../../src/reconcile/statusProjection";

const now = "2026-05-21T12:00:00.000Z";
const eventAt = "2026-05-21T12:00:01.000Z";

describe("live harness status projection", () => {
  it("projects a correlated working report onto the current snapshot", () => {
    const result = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor(),
      report: report({
        status: status("working", "medium", "Codex is about to use Bash."),
        correlation: {
          harnessRunId: "run_web_task",
        },
      }),
      projectedAt: eventAt,
    });

    expect(result.projected).toBe(true);
    expect(result.snapshot.rows[0]?.agent).toMatchObject({
      state: "working",
      confidence: "medium",
      reason: "Codex is about to use Bash.",
      updatedAt: eventAt,
    });
    expect(result.snapshot.rows[0]?.display).toMatchObject({
      statusLabel: "working",
      alert: false,
    });
    expect(result.snapshot.counts).toMatchObject({
      working: 1,
      unknown: 0,
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "worktree.agentStateChanged",
        worktreeId: "wt_web_task",
        sessionTitle: "task",
        changeSource: "harness_event_report",
        harnessEventType: "PreToolUse",
        reportId: "report_codex_1",
        agent: expect.objectContaining({ state: "working" }),
      }),
      expect.objectContaining({
        type: "session.updated",
        sessionId: "ses_web_task",
        patch: expect.objectContaining({
          status: expect.objectContaining({ value: "working", source: "harness_event" }),
        }),
      }),
    ]);
  });

  it("projects attention and idle reports through weaker unique correlations", () => {
    const attention = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor(),
      report: report({
        status: status("needs_attention", "high", "Codex requested permission."),
        correlation: {
          sessionId: "ses_web_task",
        },
      }),
      projectedAt: eventAt,
    });
    const idle = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor({ state: "working", confidence: "medium" }),
      report: report({
        status: status("idle", "high", "Codex turn completed."),
        correlation: {
          worktreeId: "wt_web_task",
        },
      }),
      projectedAt: eventAt,
    });

    expect(attention.snapshot.rows[0]?.agent?.state).toBe("needs_attention");
    expect(attention.snapshot.rows[0]?.display).toMatchObject({
      statusLabel: "needs attention",
      alert: true,
      reason: "Codex requested permission.",
    });
    expect(idle.snapshot.rows[0]?.agent?.state).toBe("idle");
    expect(idle.snapshot.rows[0]?.display).toMatchObject({
      statusLabel: "idle",
      alert: false,
    });
  });

  it("keeps unknown, mismatched, and ambiguous reports diagnostic-only", () => {
    const unknown = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor({ state: "working", confidence: "high" }),
      report: report({
        status: status("unknown", "low", "No useful hook status."),
        correlation: {
          harnessRunId: "run_web_task",
        },
      }),
      projectedAt: eventAt,
    });
    const mismatchedRun = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor(),
      report: report({
        status: status("working", "medium", "Should not fall back."),
        correlation: {
          harnessRunId: "missing_run",
          worktreeId: "wt_web_task",
        },
      }),
      projectedAt: eventAt,
    });
    const ambiguousSnapshot = snapshotFor();
    const duplicateRow = ambiguousSnapshot.rows[0];
    if (duplicateRow === undefined) {
      throw new Error("Expected fixture row.");
    }
    const ambiguous = projectHarnessEventReportOntoSnapshot({
      snapshot: {
        ...ambiguousSnapshot,
        rows: [
          duplicateRow,
          {
            ...duplicateRow,
            id: "wt_web_other",
            branch: "other",
          },
        ],
      },
      report: report({
        status: status("needs_attention", "high", "Ambiguous session."),
        correlation: {
          sessionId: "ses_web_task",
        },
      }),
      projectedAt: eventAt,
    });

    expect(unknown.projected).toBe(false);
    expect(mismatchedRun.projected).toBe(false);
    expect(ambiguous.projected).toBe(false);
  });

  it("updates same-state status refreshes without emitting state-change events", () => {
    const snapshot = snapshotWithTurnReadiness(
      snapshotFor({
        state: "idle",
        confidence: "high",
        now: "2026-05-21T12:00:00.000Z",
      }),
    );
    const result = projectHarnessEventReportOntoSnapshot({
      snapshot,
      report: report({
        status: status("idle", "high", "Codex turn completed.", "2026-05-21T12:00:02.000Z"),
        correlation: {
          harnessRunId: "run_web_task",
        },
      }),
      projectedAt: "2026-05-21T12:00:02.000Z",
    });

    expect(result.projected).toBe(true);
    expect(result.snapshot.rows[0]?.agent).toMatchObject({
      state: "idle",
      updatedAt: "2026-05-21T12:00:02.000Z",
      turnReadiness: {
        state: "ready_to_read",
        token: "report_previous",
        completedAt: "2026-05-21T12:00:01.000Z",
      },
    });
    expect(result.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree.agentStateChanged" })]),
    );
  });

  it("drops turn readiness when a projected report makes the agent non-idle", () => {
    const result = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotWithTurnReadiness(snapshotFor({ state: "idle", confidence: "high" })),
      report: report({
        status: status("working", "medium", "Codex started another turn."),
        correlation: {
          harnessRunId: "run_web_task",
        },
      }),
      projectedAt: eventAt,
    });

    expect(result.snapshot.rows[0]?.agent).toMatchObject({
      state: "working",
    });
    expect(result.snapshot.rows[0]?.agent).not.toHaveProperty("turnReadiness");
  });

  it("does not overwrite a newer high-confidence exited state with older hook activity", () => {
    const result = projectHarnessEventReportOntoSnapshot({
      snapshot: snapshotFor({
        state: "exited",
        confidence: "high",
        now: "2026-05-21T12:00:10.000Z",
      }),
      report: report({
        observedAt: "2026-05-21T12:00:05.000Z",
        status: status("working", "medium", "Older tool event.", "2026-05-21T12:00:05.000Z"),
        correlation: {
          harnessRunId: "run_web_task",
        },
      }),
      projectedAt: "2026-05-21T12:00:05.000Z",
    });

    expect(result.projected).toBe(false);
    expect(result.snapshot.rows[0]?.agent).toMatchObject({
      state: "exited",
      confidence: "high",
    });
  });
});

describe("cwd correlation resolution", () => {
  it("resolves a cwd-only report to the containing worktree and projects it", () => {
    const snapshot = snapshotFor();
    const enriched = withWorktreeCorrelationFromCwd(
      report({
        status: status("working", "medium", "Codex is about to use Bash."),
        correlation: { cwd: "/tmp/station/web/task/src/deep" },
      }),
      snapshot,
    );

    expect(enriched.correlation).toMatchObject({
      worktreeId: "wt_web_task",
      cwd: "/tmp/station/web/task/src/deep",
    });

    const result = projectHarnessEventReportOntoSnapshot({
      snapshot,
      report: enriched,
      projectedAt: eventAt,
    });
    expect(result.projected).toBe(true);
    expect(result.correlatedBy).toBe("worktreeId");
    expect(result.snapshot.rows[0]?.agent).toMatchObject({ state: "working" });
  });

  it("leaves reports with stronger correlation or an unknown cwd untouched", () => {
    const snapshot = snapshotFor();
    const strong = report({
      status: status("working", "medium", "Codex is about to use Bash."),
      correlation: { sessionId: "ses_other", cwd: "/tmp/station/web/task" },
    });
    expect(withWorktreeCorrelationFromCwd(strong, snapshot)).toBe(strong);

    const elsewhere = report({
      status: status("working", "medium", "Codex is about to use Bash."),
      correlation: { cwd: "/somewhere/unrelated" },
    });
    expect(withWorktreeCorrelationFromCwd(elsewhere, snapshot)).toBe(elsewhere);
  });

  it("picks the deepest containing worktree and drops ties as ambiguous", () => {
    const snapshot = snapshotForRows([
      { id: "wt_web_root", path: "/tmp/station/web" },
      { id: "wt_web_task", path: "/tmp/station/web/task" },
    ]);
    const nested = withWorktreeCorrelationFromCwd(
      report({
        status: status("working", "medium", "Codex is about to use Bash."),
        correlation: { cwd: "/tmp/station/web/task/src" },
      }),
      snapshot,
    );
    expect(nested.correlation?.worktreeId).toBe("wt_web_task");

    const duplicated = snapshotForRows([
      { id: "wt_a", path: "/tmp/station/web/task" },
      { id: "wt_b", path: "/tmp/station/web/task" },
    ]);
    const ambiguous = report({
      status: status("working", "medium", "Codex is about to use Bash."),
      correlation: { cwd: "/tmp/station/web/task" },
    });
    expect(withWorktreeCorrelationFromCwd(ambiguous, duplicated)).toBe(ambiguous);
  });
});

function snapshotForRows(rows: Array<{ id: string; path: string }>) {
  return buildStationSnapshot({
    generatedAt: now,
    observer: { pid: 4242, startedAt: now, version: "0.0.0", healthy: true },
    projects: [
      {
        id: "web",
        label: "web",
        root: "/tmp/station/web",
        defaults: { harness: "codex", terminal: "tmux", layout: "agent-shell" },
        worktrunk: { enabled: true },
      },
    ],
    worktreeProviderId: "fake-worktree",
    providerHealth: {},
    worktrees: rows.map((row) =>
      createFakeWorktree({ id: row.id, projectId: "web", branch: row.id, path: row.path, now }),
    ),
    terminalTargets: [],
    harnessRuns: [],
  });
}

function snapshotFor(input: { state?: AgentState; confidence?: Confidence; now?: string } = {}) {
  const worktrees = [
    createFakeWorktree({
      id: "wt_web_task",
      projectId: "web",
      branch: "task",
      path: "/tmp/station/web/task",
      now,
    }),
  ];
  const terminals = [
    createFakeTerminalTarget({
      id: "term_web_task",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      harnessRunId: "run_web_task",
      now,
    }),
  ];
  const harnessRuns = [
    observerHarnessRunFromRun(
      createFakeHarnessRun({
        id: "run_web_task",
        provider: "codex",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: input.state ?? "unknown",
        confidence: input.confidence ?? "low",
        now: input.now ?? now,
      }),
    ),
  ];
  return buildStationSnapshot({
    generatedAt: now,
    observer: {
      pid: 4242,
      startedAt: now,
      version: "0.0.0",
      healthy: true,
    },
    projects: [
      {
        id: "web",
        label: "web",
        root: "/tmp/station/web",
        defaults: {
          harness: "codex",
          terminal: "tmux",
          layout: "agent-shell",
        },
        worktrunk: {
          enabled: true,
        },
      },
    ],
    worktreeProviderId: "fake-worktree",
    providerHealth: {},
    worktrees,
    terminalTargets: terminals,
    harnessRuns,
  });
}

function snapshotWithTurnReadiness(snapshot: ReturnType<typeof snapshotFor>) {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) =>
      row.id === "wt_web_task" && row.agent !== undefined
        ? {
            ...row,
            agent: {
              ...row.agent,
              turnReadiness: {
                state: "ready_to_read" as const,
                token: "report_previous",
                completedAt: "2026-05-21T12:00:01.000Z",
              },
            },
          }
        : row,
    ),
  };
}

function report(input: {
  status: ObservedStatus;
  correlation: NonNullable<HarnessEventReport["correlation"]>;
  observedAt?: string;
}): HarnessEventReport {
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: "report_codex_1",
    provider: "codex",
    kind: "harness",
    eventType: "PreToolUse",
    observedAt: input.observedAt ?? input.status.updatedAt,
    status: input.status,
    correlation: input.correlation,
    diagnostics: {
      rawEventType: "PreToolUse",
    },
  };
}

function status(
  value: AgentState,
  confidence: Confidence,
  reason: string,
  updatedAt = eventAt,
): ObservedStatus {
  return {
    value,
    confidence,
    reason,
    source: "harness_event",
    updatedAt,
  };
}
