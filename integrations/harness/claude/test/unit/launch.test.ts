import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { HarnessLaunchPlanSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildClaudeLaunchPlan } from "../../src/launch";

const now = "2026-06-11T12:00:00.000Z";

describe("buildClaudeLaunchPlan", () => {
  it("builds a shell-safe interactive argv/env plan with config defaults", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      command: "/opt/claude/bin/claude",
      defaultProfile: "team-default",
    });

    expect(HarnessLaunchPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      provider: "claude",
      command: "/opt/claude/bin/claude",
      args: ["--agent", "team-default", "Review the task."],
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "claude",
        STATION_SESSION_ID: "ses_web_task",
        STATION_TERMINAL_PROVIDER: "tmux",
        STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
      },
      displayTitle: "web Claude",
      providerData: {
        interactive: true,
        initialPromptProvided: true,
        profile: "team-default",
        terminalProvider: "tmux",
        terminalTargetId: "tmux:station:@1:%2",
      },
    });
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
    expect(plan.args).not.toContain("--settings");
    expect(JSON.stringify(plan)).not.toContain("undefined");
    expect(JSON.stringify(plan.providerData)).not.toContain("Review the task.");
  });

  it("lets request options override provider defaults without setting absent option fields", () => {
    const base = request();
    if (base.terminalTarget === undefined) {
      throw new Error("Claude launch fixture is missing a terminal target.");
    }
    const requestWithoutPrompt: BuildHarnessLaunchRequest = {
      project: base.project,
      worktree: base.worktree,
      terminalTarget: base.terminalTarget,
      mode: "interactive",
      sessionId: "ses_web_task",
      profile: "request-profile",
    };
    const plan = buildClaudeLaunchPlan(requestWithoutPrompt, {
      defaultProfile: "team-default",
    });

    expect(plan.args).toEqual(["--agent", "request-profile"]);
    expect(plan.providerData).toMatchObject({
      profile: "request-profile",
    });
    expect(plan.providerData).not.toMatchObject({ initialPromptProvided: true });
  });

  it("maps auto permission mode to the native Claude permission flag", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      defaultPermissionMode: "auto",
    });

    expect(plan.args).toEqual(["--permission-mode", "auto", "Review the task."]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "auto",
    });
  });

  it("maps yolo permission mode to the native Claude bypass flag", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      defaultProfile: "team-default",
      defaultPermissionMode: "yolo",
    });

    expect(plan.args).toEqual([
      "--agent",
      "team-default",
      "--dangerously-skip-permissions",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });

  it("maps legacy explicit yolo args to the native Claude bypass flag", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      defaultApprovalPolicy: "never",
      defaultSandboxMode: "danger-full-access",
    });

    expect(plan.args).toEqual(["--dangerously-skip-permissions", "Review the task."]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });

  it("appends the station hook settings artifact when provided", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      hookSettingsPath: "/state/station/hooks/station-claude-settings.json",
    });

    expect(plan.args).toEqual([
      "--settings",
      "/state/station/hooks/station-claude-settings.json",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      settingsInjected: true,
    });
  });

  it("carries an isolated CLAUDE_CONFIG_DIR into the launch env", () => {
    const plan = buildClaudeLaunchPlan(request(), {
      env: { CLAUDE_CONFIG_DIR: "/tmp/station/claude-home" },
    });

    expect(plan.env).toMatchObject({
      STATION_HARNESS_PROVIDER: "claude",
      CLAUDE_CONFIG_DIR: "/tmp/station/claude-home",
    });
  });

  it("builds non-interactive claude print plans with streamed JSON events", () => {
    const plan = buildClaudeLaunchPlan(
      {
        ...request(),
        mode: "exec",
        initialPrompt: "Summarize the worktree.",
      },
      {
        defaultProfile: "team-default",
        hookSettingsPath: "/state/station/hooks/station-claude-settings.json",
      },
    );

    expect(plan.mode).toBe("exec");
    expect(plan.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--agent",
      "team-default",
      "--settings",
      "/state/station/hooks/station-claude-settings.json",
      "Summarize the worktree.",
    ]);
  });

  it("applies yolo permission mode to claude print plans", () => {
    const plan = buildClaudeLaunchPlan(
      {
        ...request(),
        mode: "exec",
        initialPrompt: "Summarize the worktree.",
      },
      {
        defaultPermissionMode: "yolo",
      },
    );

    expect(plan.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "Summarize the worktree.",
    ]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });

  it("builds interactive resume plans with exact native session args", () => {
    const plan = buildClaudeLaunchPlan({
      ...request(),
      resume: {
        target: { kind: "native-session", id: "claude_session_123" },
        previousSessionId: "ses_web_task",
        recoveryHandleId: "rec_claude",
      },
    });

    expect(plan.args).toEqual(["--resume", "claude_session_123", "Review the task."]);
    expect(plan.mode).toBe("interactive");
    expect(plan.providerData).toMatchObject({
      resume: true,
      resumeTargetKind: "native-session",
    });
  });

  it("preserves the station hook settings artifact on interactive resume plans", () => {
    const plan = buildClaudeLaunchPlan(
      {
        ...request(),
        resume: {
          target: { kind: "native-session", id: "claude_session_123" },
          previousSessionId: "ses_web_task",
          recoveryHandleId: "rec_claude",
        },
      },
      {
        hookSettingsPath: "/state/station/hooks/station-claude-settings.json",
      },
    );

    expect(plan.args).toEqual([
      "--resume",
      "claude_session_123",
      "--settings",
      "/state/station/hooks/station-claude-settings.json",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      settingsInjected: true,
      resume: true,
      resumeTargetKind: "native-session",
    });
  });

  it("rejects exec resume and unsupported resume target kinds", () => {
    expect(() =>
      buildClaudeLaunchPlan({
        ...request(),
        mode: "exec",
        resume: { target: { kind: "native-session", id: "claude_session_123" } },
      }),
    ).toThrow(/HARNESS_CLAUDE_RESUME_UNSUPPORTED/);
    expect(() =>
      buildClaudeLaunchPlan({
        ...request(),
        resume: { target: { kind: "session-file", path: "/tmp/claude-session.json" } },
      }),
    ).toThrow(/HARNESS_CLAUDE_RESUME_UNSUPPORTED/);
  });
});

function request(): BuildHarnessLaunchRequest {
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "claude",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    worktree: {
      id: "wt_web_task",
      provider: "worktrunk",
      projectId: "web",
      branch: "task",
      path: "/tmp/station/web/task",
      state: "exists",
      source: "worktrunk",
      observedAt: now,
    },
    terminalTarget: {
      id: "tmux:station:@1:%2",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_task",
      sessionId: "ses_web_task",
      state: "open",
      cwd: "/tmp/station/web/task",
      pid: 1234,
      confidence: "high",
      reason: "tmux pane has station identity binding.",
      observedAt: now,
    },
    mode: "interactive",
    sessionId: "ses_web_task",
    initialPrompt: "Review the task.",
  };
}
