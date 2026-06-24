import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { buildScriptedAgentLaunchPlan } from "../../src/launch";

const request: BuildHarnessLaunchRequest = {
  project: {
    id: "web",
    label: "web",
    root: "/tmp/station/web",
    defaults: {
      harness: "scripted",
      terminal: "fake-terminal",
      layout: "agent-shell",
    },
    worktrunk: {
      enabled: true,
    },
  },
  worktree: {
    id: "wt_web_task",
    provider: "fake-worktree",
    projectId: "web",
    branch: "task",
    path: "/tmp/station/web/task",
    state: "exists",
    source: "worktrunk",
    observedAt: "2026-05-20T12:00:00.000Z",
  },
  mode: "interactive",
  sessionId: "ses_web_task",
  initialPrompt: "Complete the scripted file task.",
};

describe("scripted harness launch plan", () => {
  it("builds a deterministic launch plan without starting a process", () => {
    const plan = buildScriptedAgentLaunchPlan(request, {
      nodeCommand: "/usr/local/bin/node",
      runnerPath: "/tmp/station/scripted-agent.mjs",
      stateDir: "/tmp/station/state/scripted",
      scenarioPath: "/tmp/station/scenarios/complete-file-task.json",
      runId: "run_web_task",
    });

    expect(plan).toMatchObject({
      provider: "scripted",
      command: "/usr/local/bin/node",
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "scripted",
        STATION_SESSION_ID: "ses_web_task",
        STATION_SCRIPTED_RUN_ID: "run_web_task",
        STATION_SCRIPTED_STATE_DIR: "/tmp/station/state/scripted",
      },
    });
    expect(plan.args).toEqual([
      "/tmp/station/scripted-agent.mjs",
      "--run-id",
      "run_web_task",
      "--state-dir",
      "/tmp/station/state/scripted",
      "--scenario",
      "/tmp/station/scenarios/complete-file-task.json",
    ]);
    expect(plan.providerData).toMatchObject({
      initialPromptProvided: true,
    });
    expect(JSON.stringify(plan)).not.toContain("Complete the scripted file task.");
  });
});
