import { describe, expect, it } from "vitest";
import { terminalTargetObservationFromBinding } from "../../src/index.js";

const now = "2026-06-04T12:00:00.000Z";

describe("terminal targets", () => {
  it("turns terminal identity bindings into normalized target observations", () => {
    expect(
      terminalTargetObservationFromBinding({
        binding: {
          provider: "tmux",
          targetId: "tmux:station:@1:%2",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          harnessBinding: {
            role: "main-agent",
            harnessProvider: "codex",
            worktreePath: "/tmp/station/web/feature",
          },
          confidence: "high",
          reason: "tmux opened the workspace.",
        },
        worktree: {
          id: "wt_web_feature",
          provider: "worktrunk",
          projectId: "web",
          branch: "feature",
          path: "/tmp/station/web/feature",
          state: "exists",
          source: "worktrunk",
          confidence: "high",
          reason: "Worktree provider created the worktree.",
          observedAt: now,
        },
        observedAt: now,
      }),
    ).toEqual({
      id: "tmux:station:@1:%2",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      state: "open",
      cwd: "/tmp/station/web/feature",
      confidence: "high",
      reason: "tmux opened the workspace.",
      observedAt: now,
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "codex",
        worktreePath: "/tmp/station/web/feature",
      },
    });
  });
});
