import type { SessionView, StationEvent, StationSnapshot, WorktreeRow } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  formatEventLines,
  formatJsonEnvelope,
  formatSnapshotLines,
} from "../../src/commands/observe/formatters.js";
import {
  applyEventToSnapshotContext,
  createObserveSnapshotContext,
  sessionLabel,
  worktreeLabel,
} from "../../src/commands/observe/snapshotContext.js";

const now = "2026-06-05T12:00:00.000Z";

describe("observe formatters", () => {
  it("renders snapshot summaries and agent rows from snapshot truth", () => {
    const snapshot = snapshotFixture();
    const context = createObserveSnapshotContext(snapshot);

    expect(formatSnapshotLines(snapshot, context, now)).toEqual([
      "12:00:00  snapshot   1 project  1 worktree  1 agent  working:1 idle:0 attention:0",
      "12:00:00  agent      api feature/cache  working  codex  high  dirty  tmux/open",
    ]);
  });

  it("uses cached project and branch labels for agent events", () => {
    const context = createObserveSnapshotContext(snapshotFixture());

    expect(
      formatEventLines(
        {
          type: "worktree.agentStateChanged",
          worktreeId: "wt_api",
          agent: {
            harness: "codex",
            state: "needs_attention",
            confidence: "high",
            reason: "blocked",
            updatedAt: now,
          },
        },
        context,
        now,
      ),
    ).toEqual([
      "12:00:00  agent!     api feature/cache  needs attention  codex  high  dirty  tmux/open",
    ]);
  });

  it("renders command failures with command, trace, diagnostic, message, and hint lines", () => {
    const context = createObserveSnapshotContext(snapshotFixture());
    applyEventToSnapshotContext(context, {
      type: "command.started",
      commandId: "cmd_1",
      command: { type: "observer.reconcile", payload: { reason: "test" } },
      traceId: "trc_1",
    });

    expect(
      formatEventLines(
        {
          type: "command.failed",
          commandId: "cmd_1",
          traceId: "trc_1",
          error: {
            tag: "ProviderError",
            code: "PROVIDER_UNAVAILABLE",
            message: "Provider is unavailable.",
            hint: "Run station doctor.",
            provider: "codex",
            diagnosticId: "diag_1",
          },
        },
        context,
        now,
      ),
    ).toEqual([
      "12:00:00  command!   failed  observer.reconcile  PROVIDER_UNAVAILABLE  provider:codex  cmd:cmd_1  trace:trc_1  diag:diag_1",
      "            Provider is unavailable.",
      "            hint: Run station doctor.",
    ]);
  });

  it("serializes stable JSONL envelopes", () => {
    const event: StationEvent = { type: "observer.started", at: now };
    expect(formatJsonEnvelope({ kind: "event", seq: 2, receivedAt: now, event })).toBe(
      `${JSON.stringify({ kind: "event", seq: 2, receivedAt: now, event })}\n`,
    );
  });
});

describe("observe snapshot context", () => {
  it("falls back to ids until graph events populate labels", () => {
    const context = createObserveSnapshotContext();

    expect(worktreeLabel(context, "wt_api")).toBe("wt_api");
    expect(sessionLabel(context, "ses_1")).toBe("ses_1");

    applyEventToSnapshotContext(context, { type: "worktree.added", row: rowFixture() });
    applyEventToSnapshotContext(context, { type: "session.created", session: sessionFixture() });

    expect(worktreeLabel(context, "wt_api")).toBe("api feature/cache");
    expect(sessionLabel(context, "ses_1")).toBe("Cache API");
  });
});

function snapshotFixture(): StationSnapshot {
  return {
    schemaVersion: "0.7.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {},
    projects: [
      {
        id: "api",
        label: "api",
        root: "/tmp/api",
        defaults: {
          harness: "codex",
          terminal: "tmux",
          layout: "agent-only",
        },
        health: {
          providerId: "worktrunk",
          providerType: "worktree",
          status: "healthy",
          lastCheckedAt: now,
        },
        counts: {
          worktrees: 1,
          agents: 1,
          working: 1,
          idle: 0,
          attention: 0,
          unknown: 0,
        },
      },
    ],
    rows: [rowFixture()],
    sessions: [sessionFixture()],
    counts: {
      projects: 1,
      worktrees: 1,
      agents: 1,
      working: 1,
      idle: 0,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  };
}

function rowFixture(): WorktreeRow {
  return {
    id: "wt_api",
    projectId: "api",
    projectLabel: "api",
    branch: "feature/cache",
    path: "/tmp/api/feature-cache",
    worktree: {
      state: "exists",
      source: "worktrunk",
      dirty: true,
    },
    terminal: {
      provider: "tmux",
      state: "open",
    },
    agent: {
      harness: "codex",
      state: "working",
      confidence: "high",
      reason: "hook",
      updatedAt: now,
      sessionId: "ses_1",
    },
    display: {
      statusLabel: "working",
      sortPriority: 20,
      alert: false,
    },
  };
}

function sessionFixture(): SessionView {
  return {
    id: "ses_1",
    projectId: "api",
    worktreeId: "wt_api",
    createdAt: now,
    updatedAt: now,
    harness: {
      provider: "codex",
      mode: "interactive",
      capabilities: {
        canLaunch: true,
        canDiscoverRuns: true,
        canEmitEvents: true,
        canClassifyStatus: true,
        canReceivePrompt: true,
        canResume: false,
        canStop: true,
        canRunNonInteractive: false,
        canExposeApprovalState: true,
        supportsModifiedEnterSoftNewline: false,
      },
    },
    terminal: {
      provider: "tmux",
      exists: true,
    },
    status: {
      value: "working",
      confidence: "high",
      reason: "hook",
      source: "harness_hook",
      updatedAt: now,
    },
    title: "Cache API",
    tags: [],
  };
}
