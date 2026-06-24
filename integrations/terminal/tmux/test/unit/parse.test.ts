import { TerminalTargetObservationSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { parseTmuxTargetLines } from "../../src/parse";

const now = "2026-05-21T12:00:00.000Z";

describe("tmux target parser", () => {
  it("normalizes workbench pane output into TerminalTargetObservation values", () => {
    const targets = parseTmuxTargetLines(
      [
        [
          "station",
          "@1",
          "%2",
          "1",
          "0",
          "",
          "/tmp/station/web/feature",
          "12345",
          "codex",
          "web-feature",
          "ses_web_feature",
          "web",
          "wt_web_feature",
          "/tmp/station/web/feature",
          "main-agent",
          "codex",
        ].join("\t"),
      ].join("\n"),
      { observedAt: now },
    );

    expect(targets).toHaveLength(1);
    expect(TerminalTargetObservationSchema.parse(targets[0])).toEqual(targets[0]);
    expect(targets[0]).toMatchObject({
      id: "tmux:station:@1:%2",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      state: "open",
      cwd: "/tmp/station/web/feature",
      pid: 12345,
      title: "web-feature",
      confidence: "high",
      reason: "tmux pane has station identity binding.",
      harnessBinding: {
        role: "main-agent",
        harnessProvider: "codex",
        worktreePath: "/tmp/station/web/feature",
        currentCommand: "codex",
      },
      providerData: {
        sessionName: "station",
        windowName: "web-feature",
        windowId: "@1",
        paneId: "%2",
        paneTarget: "%2",
        attached: true,
        dead: false,
      },
    });
  });

  it("keeps unbound panes low-confidence and provider-specific", () => {
    const targets = parseTmuxTargetLines(
      [
        "station",
        "@1",
        "%3",
        "0",
        "0",
        "",
        "/tmp/random",
        "",
        "zsh",
        "scratch",
        "",
        "",
        "",
        "",
        "",
      ].join("\t"),
      { observedAt: now },
    );

    expect(targets).toEqual([
      expect.objectContaining({
        id: "tmux:station:@1:%3",
        state: "detached",
        confidence: "low",
        reason: "tmux pane is missing station identity binding.",
        providerData: expect.objectContaining({
          sessionName: "station",
          windowName: "scratch",
          windowId: "@1",
          paneId: "%3",
          paneTarget: "%3",
          attached: false,
          dead: false,
        }),
      }),
    ]);
  });

  it("marks dead tmux panes as stale targets", () => {
    const targets = parseTmuxTargetLines(
      [
        [
          "station",
          "@1",
          "%4",
          "1",
          "1",
          "0",
          "",
          "",
          "codex",
          "web-feature",
          "ses_web_feature",
          "web",
          "wt_web_feature",
          "/tmp/station/web/feature",
          "main-agent",
          "codex",
        ].join("\t"),
      ].join("\n"),
      { observedAt: now },
    );

    expect(TerminalTargetObservationSchema.parse(targets[0])).toEqual(targets[0]);
    expect(targets[0]).toMatchObject({
      id: "tmux:station:@1:%4",
      state: "stale",
      confidence: "high",
      reason: "tmux pane has station identity binding but is dead.",
      providerData: {
        dead: true,
        deadStatus: "0",
      },
    });
  });
});
