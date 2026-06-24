import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { HarnessLaunchPlanSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { PiHarnessProviderError } from "../../src/errors";
import { buildPiLaunchPlan } from "../../src/launch";

const now = "2026-05-27T12:00:00.000Z";

describe("buildPiLaunchPlan", () => {
  it("builds an interactive Pi launch with STATION extension and correlation env", () => {
    const plan = buildPiLaunchPlan(request(), {
      command: "/opt/pi/bin/pi",
      extensionPath: "/opt/station/piExtension.js",
      configPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
    });

    expect(HarnessLaunchPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({
      provider: "pi",
      command: "/opt/pi/bin/pi",
      args: ["--extension", "/opt/station/piExtension.js", "Review the task."],
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "pi",
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
        extensionPath: "/opt/station/piExtension.js",
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

  it("does not require persistent extension installation", () => {
    const plan = buildPiLaunchPlan(requestWithoutPrompt(), {
      extensionPath: "/tmp/station/piExtension.js",
    });

    expect(plan.args).toEqual(["--extension", "/tmp/station/piExtension.js"]);
    expect(plan.providerData).toMatchObject({
      extensionPath: "/tmp/station/piExtension.js",
    });
    expect(plan.providerData).not.toMatchObject({ initialPromptProvided: true });
  });

  it("defaults to the compiled standalone Pi extension artifact", () => {
    const plan = buildPiLaunchPlan(requestWithoutPrompt());

    expect(plan.args[0]).toBe("--extension");
    expect(plan.args[1]).toMatch(/\/integrations\/harness\/pi\/dist\/piExtension\.js$/);
  });

  it("rejects exec mode while Pi JSON/RPC control is not implemented", () => {
    expect(() =>
      buildPiLaunchPlan({
        ...request(),
        mode: "exec",
      }),
    ).toThrowError(PiHarnessProviderError);
  });

  it("builds interactive resume plans from session-file and native-session targets", () => {
    const filePlan = buildPiLaunchPlan(
      {
        ...request(),
        resume: {
          target: { kind: "session-file", path: "/tmp/pi-session.json" },
          recoveryHandleId: "rec_pi_file",
        },
      },
      {
        extensionPath: "/opt/station/piExtension.js",
      },
    );
    expect(filePlan.args).toEqual([
      "--extension",
      "/opt/station/piExtension.js",
      "--session",
      "/tmp/pi-session.json",
      "Review the task.",
    ]);
    expect(filePlan.providerData).toMatchObject({
      resume: true,
      resumeTargetKind: "session-file",
    });

    const nativePlan = buildPiLaunchPlan(
      {
        ...requestWithoutPrompt(),
        resume: { target: { kind: "native-session", id: "pi_session_123" } },
      },
      {
        extensionPath: "/opt/station/piExtension.js",
      },
    );
    expect(nativePlan.args).toEqual([
      "--extension",
      "/opt/station/piExtension.js",
      "--session",
      "pi_session_123",
    ]);
  });

  it("rejects exec resume until Pi exec fidelity is proven", () => {
    expect(() =>
      buildPiLaunchPlan({
        ...request(),
        mode: "exec",
        resume: { target: { kind: "session-file", path: "/tmp/pi-session.json" } },
      }),
    ).toThrow(/HARNESS_PI_RESUME_UNSUPPORTED/);
  });
});

function requestWithoutPrompt(): BuildHarnessLaunchRequest {
  const base = request();
  const output: BuildHarnessLaunchRequest = {
    project: base.project,
    worktree: base.worktree,
    mode: "interactive",
  };
  if (base.terminalTarget !== undefined) {
    output.terminalTarget = base.terminalTarget;
  }
  if (base.sessionId !== undefined) {
    output.sessionId = base.sessionId;
  }
  return output;
}

function request(): BuildHarnessLaunchRequest {
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "pi",
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
