import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { HarnessLaunchPlanSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildCodexLaunchPlan } from "../../src/launch";

const now = "2026-05-21T12:00:00.000Z";

describe("buildCodexLaunchPlan", () => {
  it("builds a shell-safe interactive argv/env plan with config defaults", () => {
    const plan = buildCodexLaunchPlan(request(), {
      command: "/opt/codex/bin/codex",
      defaultProfile: "team-default",
      defaultApprovalPolicy: "on-request",
      defaultSandboxMode: "workspace-write",
      noAltScreen: true,
    });

    expect(HarnessLaunchPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      provider: "codex",
      command: "/opt/codex/bin/codex",
      args: [
        "--cd",
        "/tmp/station/web/task",
        "--profile",
        "team-default",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "--no-alt-screen",
        "Review the task.",
      ],
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "codex",
        STATION_SESSION_ID: "ses_web_task",
        STATION_TERMINAL_PROVIDER: "tmux",
        STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
      },
      providerData: {
        interactive: true,
        initialPromptProvided: true,
        profile: "team-default",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        noAltScreen: true,
      },
    });
    expect(plan.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(plan.args).not.toContain("--yolo");
    expect(JSON.stringify(plan)).not.toContain("undefined");
    expect(JSON.stringify(plan.providerData)).not.toContain("Review the task.");
  });

  it("stamps the resolved managed-worktree root for hook identity corroboration", () => {
    const input = request();
    input.project.worktrunk.managedRoot = "/tmp/station/web/.worktrees";

    expect(buildCodexLaunchPlan(input).env).toMatchObject({
      STATION_WORKTREE_MANAGED_ROOT: "/tmp/station/web/.worktrees",
    });
  });

  it("lets request options override provider defaults without setting absent option fields", () => {
    const base = request();
    if (base.terminalTarget === undefined) {
      throw new Error("Codex launch fixture is missing a terminal target.");
    }
    const requestWithoutPrompt: BuildHarnessLaunchRequest = {
      project: base.project,
      worktree: base.worktree,
      terminalTarget: base.terminalTarget,
      mode: "interactive",
      sessionId: "ses_web_task",
      profile: "request-profile",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    };
    const plan = buildCodexLaunchPlan(requestWithoutPrompt, {
      defaultProfile: "team-default",
      defaultApprovalPolicy: "on-request",
      defaultSandboxMode: "workspace-write",
    });

    expect(plan.args).toEqual([
      "--cd",
      "/tmp/station/web/task",
      "--profile",
      "request-profile",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ]);
    expect(plan.providerData).toMatchObject({
      profile: "request-profile",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    expect(plan.providerData).not.toMatchObject({ initialPromptProvided: true });
  });

  it("maps yolo permission mode to the native Codex bypass flag", () => {
    const plan = buildCodexLaunchPlan(request(), {
      defaultProfile: "team-default",
      defaultPermissionMode: "yolo",
      defaultApprovalPolicy: "on-request",
      defaultSandboxMode: "workspace-write",
    });

    expect(plan.args).toEqual([
      "--cd",
      "/tmp/station/web/task",
      "--profile",
      "team-default",
      "--dangerously-bypass-approvals-and-sandbox",
      "Review the task.",
    ]);
    expect(plan.args).not.toContain("--sandbox");
    expect(plan.args).not.toContain("--ask-for-approval");
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
    expect(plan.providerData).not.toMatchObject({
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
  });

  it("maps legacy explicit yolo args to the native Codex bypass flag", () => {
    const plan = buildCodexLaunchPlan(request(), {
      defaultApprovalPolicy: "never",
      defaultSandboxMode: "danger-full-access",
    });

    expect(plan.args).toEqual([
      "--cd",
      "/tmp/station/web/task",
      "--dangerously-bypass-approvals-and-sandbox",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
    expect(plan.args).not.toContain("--sandbox");
    expect(plan.args).not.toContain("--ask-for-approval");
  });

  it("uses the station profile with the current Codex profile flag", () => {
    const plan = buildCodexLaunchPlan(request(), {
      defaultProfile: "team-default",
      defaultHookProfile: "station",
    });

    expect(plan.args).toEqual([
      "--cd",
      "/tmp/station/web/task",
      "--profile",
      "station",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      profile: "station",
      hookProfile: "station",
      configuredProfile: "team-default",
    });
  });

  it("carries an isolated CODEX_HOME into the launch env", () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/station/codex-home";
    try {
      const plan = buildCodexLaunchPlan(request());

      expect(plan.env).toMatchObject({
        STATION_HARNESS_PROVIDER: "codex",
        CODEX_HOME: "/tmp/station/codex-home",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
    }
  });

  it("builds non-interactive codex exec plans with JSON events", () => {
    const plan = buildCodexLaunchPlan(
      {
        ...request(),
        mode: "exec",
        initialPrompt: "Summarize the worktree.",
      },
      {
        defaultProfile: "team-default",
        defaultApprovalPolicy: "never",
        defaultSandboxMode: "workspace-write",
        noAltScreen: true,
      },
    );

    expect(plan.mode).toBe("exec");
    expect(plan.args).toEqual([
      "exec",
      "--json",
      "--cd",
      "/tmp/station/web/task",
      "--profile",
      "team-default",
      "--sandbox",
      "workspace-write",
      "Summarize the worktree.",
    ]);
    expect(plan.args).not.toContain("--ask-for-approval");
    expect(plan.args).not.toContain("--no-alt-screen");
  });

  it("applies yolo permission mode to codex exec plans", () => {
    const plan = buildCodexLaunchPlan(
      {
        ...request(),
        mode: "exec",
        initialPrompt: "Summarize the worktree.",
      },
      {
        defaultPermissionMode: "yolo",
        defaultApprovalPolicy: "never",
        defaultSandboxMode: "danger-full-access",
      },
    );

    expect(plan.args).toEqual([
      "exec",
      "--json",
      "--cd",
      "/tmp/station/web/task",
      "--dangerously-bypass-approvals-and-sandbox",
      "Summarize the worktree.",
    ]);
    expect(plan.args).not.toContain("--sandbox");
    expect(plan.args).not.toContain("--ask-for-approval");
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });

  it("builds interactive resume plans with exact native session args", () => {
    const plan = buildCodexLaunchPlan({
      ...request(),
      resume: {
        target: { kind: "native-session", id: "codex_session_123" },
        previousSessionId: "ses_web_task",
        recoveryHandleId: "rec_codex",
      },
    });

    expect(plan.args).toEqual([
      "resume",
      "--cd",
      "/tmp/station/web/task",
      "codex_session_123",
      "Review the task.",
    ]);
    expect(plan.mode).toBe("interactive");
    expect(plan.providerData).toMatchObject({
      resume: true,
      resumeTargetKind: "native-session",
    });
  });

  it("preserves the station hook profile on interactive resume plans", () => {
    const plan = buildCodexLaunchPlan(
      {
        ...request(),
        profile: "team-default",
        resume: {
          target: { kind: "native-session", id: "codex_session_123" },
          previousSessionId: "ses_web_task",
          recoveryHandleId: "rec_codex",
        },
      },
      {
        defaultHookProfile: "station",
      },
    );

    expect(plan.args).toEqual([
      "resume",
      "--cd",
      "/tmp/station/web/task",
      "--profile",
      "station",
      "codex_session_123",
      "Review the task.",
    ]);
    expect(plan.providerData).toMatchObject({
      profile: "station",
      hookProfile: "station",
      configuredProfile: "team-default",
      resume: true,
      resumeTargetKind: "native-session",
    });
  });

  it("rejects exec resume and unsupported resume target kinds", () => {
    expect(() =>
      buildCodexLaunchPlan({
        ...request(),
        mode: "exec",
        resume: { target: { kind: "native-session", id: "codex_session_123" } },
      }),
    ).toThrow(/HARNESS_CODEX_RESUME_UNSUPPORTED/);
    expect(() =>
      buildCodexLaunchPlan({
        ...request(),
        resume: { target: { kind: "session-file", path: "/tmp/codex-session.json" } },
      }),
    ).toThrow(/HARNESS_CODEX_RESUME_UNSUPPORTED/);
  });
});

function request(): BuildHarnessLaunchRequest {
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
