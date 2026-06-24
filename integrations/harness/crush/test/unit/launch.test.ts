import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { HarnessLaunchPlanSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildCrushLaunchPlan } from "../../src/provider";

const now = "2026-06-19T12:00:00.000Z";

describe("buildCrushLaunchPlan", () => {
  it("builds an interactive Crush launch with STATION correlation env", () => {
    const plan = buildCrushLaunchPlan(request(), {
      command: "/opt/crush/bin/crush",
      configPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });

    expect(HarnessLaunchPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      provider: "crush",
      command: "/opt/crush/bin/crush",
      args: [],
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "crush",
        STATION_SESSION_ID: "ses_web_task",
        STATION_TERMINAL_PROVIDER: "tmux",
        STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
        STATION_CONFIG_PATH: "/tmp/station/config.toml",
        STATION_OBSERVER_SOCKET_PATH: "/tmp/station/run/observer.sock",
        STATION_OBSERVER_STATE_DIR: "/tmp/station/state",
        STATION_HOOK_SPOOL_DIR: "/tmp/station/state/spool/hooks",
      },
      providerData: {
        interactive: true,
        initialPromptProvided: true,
        configPathProvided: true,
        observerSocketPathProvided: true,
        terminalProvider: "tmux",
        terminalTargetId: "tmux:station:@1:%2",
      },
    });
    expect(JSON.stringify(plan.providerData)).not.toContain("Review the task.");
    expect(JSON.stringify(plan)).not.toContain("undefined");
  });

  it("uses crush run for exec mode prompts", () => {
    const plan = buildCrushLaunchPlan({ ...request(), mode: "exec" });

    expect(plan).toMatchObject({
      provider: "crush",
      command: "crush",
      args: ["run", "--quiet", "Review the task."],
      mode: "exec",
      providerData: {
        interactive: false,
        initialPromptProvided: true,
      },
    });
  });

  it("rejects yolo exec launches because Crush run has no yolo flag", () => {
    expect.assertions(1);
    try {
      buildCrushLaunchPlan({
        ...request(),
        mode: "exec",
        permissionMode: "yolo",
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "HARNESS_CRUSH_EXEC_YOLO_UNSUPPORTED",
      });
    }
  });

  it("maps yolo permission mode to Crush's yolo flag", () => {
    const plan = buildCrushLaunchPlan(
      {
        ...request(),
        permissionMode: "yolo",
      },
      {},
    );

    expect(plan.args).toEqual(["--yolo"]);
    expect(plan.providerData).toMatchObject({
      permissionMode: "yolo",
    });
  });
});

function request(): BuildHarnessLaunchRequest {
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "crush",
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
