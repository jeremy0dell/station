import type { TerminalTargetObservation } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { terminalTargetDebugFromObservations } from "../../src/reconcile/terminalTargetDebug";

const observedAt = "2026-08-20T12:00:00.000Z";

describe("terminal target debug projection", () => {
  it("preserves normalized correlations and explicit false while removing provider mechanics", () => {
    const target: TerminalTargetObservation = {
      id: "tmux:station:@1:%2",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      harnessRunId: "run_web_feature",
      state: "detached",
      focusable: true,
      closeable: false,
      hasManagedAttachment: false,
      cwd: "/private/worktree",
      pid: 1234,
      title: "private pane title",
      confidence: "high",
      reason: "Normalized tmux target evidence.",
      observedAt,
      providerData: {
        paneId: "%2",
        socketPath: "/private/tmux.sock",
      },
    };

    expect(terminalTargetDebugFromObservations([target])).toEqual([
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: "ses_web_feature",
        state: "detached",
        focusable: true,
        closeable: false,
        hasManagedAttachment: false,
        confidence: "high",
        reason: "Normalized tmux target evidence.",
        observedAt,
      },
    ]);
  });

  it("omits optional evidence that the provider did not establish", () => {
    const target: TerminalTargetObservation = {
      id: "term_unknown",
      provider: "terminal",
      state: "unknown",
      confidence: "low",
      reason: "Target identity is incomplete.",
      observedAt,
    };

    expect(terminalTargetDebugFromObservations([target])).toEqual([
      {
        id: "term_unknown",
        provider: "terminal",
        state: "unknown",
        confidence: "low",
        reason: "Target identity is incomplete.",
        observedAt,
      },
    ]);
  });
});
