import type { HarnessRunObservation } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { classifyClaudeRunStatus } from "../../src/classify";

const now = "2026-06-11T12:00:00.000Z";

describe("classifyClaudeRunStatus", () => {
  it("keeps terminal-only Claude evidence unknown with low confidence", () => {
    const status = classifyClaudeRunStatus(run());

    expect(status).toMatchObject({
      provider: "claude",
      runId: "claude:tmux:station:@1:%2",
      status: {
        value: "unknown",
        confidence: "low",
        source: "harness_process",
      },
    });
    expect(status.status.reason).toContain("no reliable Claude status signal");
  });

  it("preserves reliable needs_attention hook observations", () => {
    const status = classifyClaudeRunStatus({
      ...run(),
      state: "needs_attention",
      confidence: "high",
      reason: "Claude Code requested permission for Bash.",
      providerData: {
        latestEvent: {
          hookEventName: "PermissionRequest",
        },
      },
    });

    expect(status.status).toMatchObject({
      value: "needs_attention",
      confidence: "high",
      source: "harness_event",
      reason: "Claude Code requested permission for Bash.",
    });
  });

  it("preserves exited process observations", () => {
    const base = run();
    const exited: HarnessRunObservation = {
      id: base.id,
      provider: base.provider,
      state: "exited",
      confidence: "high",
      reason: "Claude Code process exited.",
      observedAt: base.observedAt,
    };
    if (base.projectId !== undefined) exited.projectId = base.projectId;
    if (base.worktreeId !== undefined) exited.worktreeId = base.worktreeId;
    if (base.sessionId !== undefined) exited.sessionId = base.sessionId;
    if (base.cwd !== undefined) exited.cwd = base.cwd;
    if (base.providerData !== undefined) exited.providerData = base.providerData;

    const status = classifyClaudeRunStatus(exited);

    expect(status.status).toMatchObject({
      value: "exited",
      confidence: "high",
      source: "harness_process",
    });
  });
});

function run(): HarnessRunObservation {
  return {
    id: "claude:tmux:station:@1:%2",
    provider: "claude",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    pid: 1234,
    cwd: "/tmp/station/web/task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to Claude Code; no reliable lifecycle signal yet.",
    observedAt: now,
    providerData: {
      terminalTargetId: "tmux:station:@1:%2",
      terminalProvider: "tmux",
      process: {
        command: "claude",
      },
    },
  };
}
