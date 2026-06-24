import type { TerminalLaunchProcessRequest } from "@station/contracts";
import { buildRespawnPaneLaunchArgs, resolveLaunchPaneTarget } from "@station/tmux";
import { describe, expect, it } from "vitest";

describe("tmux launch providerData", () => {
  it("uses a schema-backed pane target when providerData is valid", () => {
    expect(
      resolveLaunchPaneTarget(
        request({
          paneTarget: "station:web-feature-login.0",
          ignoredFutureField: true,
        }),
      ),
    ).toBe("station:web-feature-login.0");
  });

  it("falls back to the agent endpoint when providerData is missing or malformed", () => {
    expect(resolveLaunchPaneTarget(request(undefined))).toBe("%web-feature-login-main");
    expect(resolveLaunchPaneTarget(request({ paneTarget: "" }))).toBe("%web-feature-login-main");
    expect(resolveLaunchPaneTarget(request({ paneTarget: 123 }))).toBe("%web-feature-login-main");
  });

  it("builds respawn-pane argv without a visible cd/env typed command", () => {
    const args = buildRespawnPaneLaunchArgs({
      paneTarget: "station:web-feature-login.0",
      cwdFallback: "/tmp/station/web/fallback",
      plan: {
        provider: "codex",
        command: "/Applications/Codex CLI/codex",
        args: [
          "--cd",
          "/tmp/station/web/feature",
          "--ask-for-approval",
          "on-request",
          "prompt with spaces",
        ],
        cwd: "/tmp/station/web/feature dir",
        env: {
          STATION_SESSION_ID: "ses_web_feature",
          STATION_TOKEN: "value with spaces",
        },
        mode: "interactive",
      },
    });

    expect(args).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "station:web-feature-login.0",
      "-c",
      "/tmp/station/web/feature dir",
      "-e",
      "STATION_SESSION_ID=ses_web_feature",
      "-e",
      "STATION_TOKEN=value with spaces",
      "'/Applications/Codex CLI/codex' --cd '/tmp/station/web/feature' --ask-for-approval on-request 'prompt with spaces'",
    ]);
    expect(args).not.toContain("send-keys");
    expect(args.at(-1)).not.toMatch(/^cd\s/);
    expect(args.at(-1)).not.toContain(" && env ");
  });

  it("uses the worktree path fallback as the respawn cwd when the plan omits cwd", () => {
    expect(
      buildRespawnPaneLaunchArgs({
        paneTarget: "%web-feature-login-main",
        cwdFallback: "/tmp/station/web/feature",
        plan: {
          provider: "codex",
          command: "codex",
          args: [],
          mode: "interactive",
        },
      }),
    ).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "%web-feature-login-main",
      "-c",
      "/tmp/station/web/feature",
      "codex",
    ]);
  });
});

function request(providerData: unknown): TerminalLaunchProcessRequest {
  return {
    project: {
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
    worktree: {
      id: "wt_web_feature",
      provider: "worktrunk",
      projectId: "web",
      branch: "feature/login",
      path: "/tmp/station/web/feature",
      state: "exists",
      source: "worktrunk",
      observedAt: "2026-05-21T12:00:00.000Z",
    },
    terminalTarget: {
      provider: "tmux",
      targetId: "tmux:station:@web-feature-login:%web-feature-login-main",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      confidence: "high",
      reason: "Fixture binding.",
      providerData,
    },
    agentEndpointId: "%web-feature-login-main",
    launchPlan: {
      provider: "codex",
      command: "codex",
      args: [],
      mode: "interactive",
    },
  };
}
