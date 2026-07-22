import type { ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { tmuxListTargetsFormat } from "../../src/parse";
import { TmuxProvider } from "../../src/provider";
import { buildWorkbenchWindowName } from "../../src/topology";
import { tmuxCommandResult } from "../support/commands";

const now = "2026-05-21T12:00:00.000Z";
const project = {
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
    base: "main",
  },
};
const worktree = {
  id: "wt_web_feature",
  provider: "worktrunk",
  projectId: "web",
  branch: "feature/login",
  path: "/tmp/station/web/feature",
  state: "exists" as const,
  source: "worktrunk" as const,
  observedAt: now,
};
const windowName = buildWorkbenchWindowName({
  projectId: project.id,
  branch: worktree.branch,
  worktreeId: worktree.id,
  path: worktree.path,
});
const windowTarget = `station:${windowName}`;
const paneTarget = `${windowTarget}.0`;

describe("TmuxProvider", () => {
  it("declares the reference tmux capabilities", () => {
    const provider = new TmuxProvider();

    expect(provider.id).toBe("tmux");
    expect(provider.capabilities()).toEqual({
      canOpenWorkspace: true,
      canFocusTarget: true,
      canCloseTarget: true,
      canCaptureOutput: true,
      canSendInput: true,
      canPersistIdentityBinding: true,
      canDisplayPopup: true,
    });
  });

  it("keeps provider health errors lean while command evidence stays internal", async () => {
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async () => {
        throw Object.assign(new Error("failed"), { code: 1, stderr: "tmux probe failed" });
      },
    });

    const health = await provider.health();

    expect(health.lastError).toEqual({
      tag: "TerminalProviderError",
      code: "TERMINAL_TMUX_UNAVAILABLE",
      message: "tmux is not available.",
      hint: "Install tmux or choose a different terminal provider.",
      provider: "tmux",
    });
    expect(JSON.stringify(health.lastError)).not.toContain("diagnosticDetails");
  });

  it("opens or reuses a workbench window and binds the primary pane identity", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "has-session") {
          throw Object.assign(new Error("missing"), { code: 1, stderr: "can't find session" });
        }
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "station\t@7\t%8");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.openWorkspace({
        project,
        worktree,
        harness: "codex",
        layout: "agent-shell",
        sessionId: "ses_web_feature",
      }),
    ).resolves.toMatchObject({
      target: {
        provider: "tmux",
        targetId: "tmux:station:@7:%8",
        projectId: "web",
        worktreeId: "wt_web_feature",
        sessionId: "ses_web_feature",
        confidence: "high",
      },
      agentEndpointId: "%8",
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "station"],
      ["new-session", "-d", "-s", "station", "-n", windowName, "-c", "/tmp/station/web/feature"],
      ["set-option", "-t", "station", "mouse", "on"],
      ["set-option", "-t", "station", "history-limit", "100000"],
      ["set-option", "-t", "station", "set-clipboard", "on"],
      ["set-option", "-w", "-t", windowTarget, "@station.session_id", "ses_web_feature"],
      ["set-option", "-w", "-t", windowTarget, "@station.project_id", "web"],
      ["set-option", "-w", "-t", windowTarget, "@station.worktree_id", "wt_web_feature"],
      [
        "set-option",
        "-w",
        "-t",
        windowTarget,
        "@station.worktree_path",
        "/tmp/station/web/feature",
      ],
      ["set-option", "-p", "-t", paneTarget, "@station.role", "main-agent"],
      ["set-option", "-p", "-t", paneTarget, "@station.harness", "codex"],
      ["display-message", "-p", "-t", paneTarget, "#{session_name}\t#{window_id}\t#{pane_id}"],
    ]);
  });

  it("appends new workbench windows to an existing tmux session", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "new-window") {
          return tmuxCommandResult(input, "station\t@9\t%10");
        }
        if (input.args?.[0] === "list-windows") {
          return tmuxCommandResult(input, "web-other-branch\n");
        }
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "station\t@9\t%10");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.openWorkspace({
        project,
        worktree,
        harness: "codex",
        layout: "agent-shell",
        sessionId: "ses_web_feature",
      }),
    ).resolves.toMatchObject({
      target: {
        targetId: "tmux:station:@9:%10",
      },
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["has-session", "-t", "station"],
      ["list-panes", "-t", "station", "-F", tmuxListTargetsFormat],
      ["list-windows", "-t", "station", "-F", "#{window_name}"],
      [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_name}\t#{window_id}\t#{pane_id}",
        "-t",
        "station:",
        "-n",
        windowName,
        "-c",
        "/tmp/station/web/feature",
      ],
      ["set-option", "-t", "station", "mouse", "on"],
      ["set-option", "-t", "station", "history-limit", "100000"],
      ["set-option", "-t", "station", "set-clipboard", "on"],
      ["set-option", "-w", "-t", "station:@9", "@station.session_id", "ses_web_feature"],
      ["set-option", "-w", "-t", "station:@9", "@station.project_id", "web"],
      ["set-option", "-w", "-t", "station:@9", "@station.worktree_id", "wt_web_feature"],
      [
        "set-option",
        "-w",
        "-t",
        "station:@9",
        "@station.worktree_path",
        "/tmp/station/web/feature",
      ],
      ["set-option", "-p", "-t", "%10", "@station.role", "main-agent"],
      ["set-option", "-p", "-t", "%10", "@station.harness", "codex"],
      ["display-message", "-p", "-t", "%10", "#{session_name}\t#{window_id}\t#{pane_id}"],
    ]);
  });

  it("does not reuse an unmatched stale window just because the window name collides", async () => {
    const calls: ExternalCommandInput[] = [];
    const collidingWorktree = {
      ...worktree,
      id: "wt_web_feature_auth",
      branch: "feature/auth",
      path: "/tmp/station/web/feature-auth",
    };
    const collidingWindowName = buildWorkbenchWindowName({
      projectId: project.id,
      branch: collidingWorktree.branch,
      worktreeId: collidingWorktree.id,
      path: collidingWorktree.path,
    });
    const forcedWindowName = buildWorkbenchWindowName({
      projectId: project.id,
      branch: collidingWorktree.branch,
      worktreeId: collidingWorktree.id,
      path: collidingWorktree.path,
      forceHash: true,
    });
    expect(forcedWindowName).toBe(collidingWindowName);
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "new-window") {
          return tmuxCommandResult(input, "station\t@new\t%new");
        }
        if (input.args?.[0] === "list-panes") {
          return tmuxCommandResult(
            input,
            [
              "station",
              "@stale",
              "%stale",
              "1",
              "0",
              "",
              "/tmp/station/web/feature-auth-stale",
              "12345",
              "codex",
              collidingWindowName,
              "ses_web_feature_auth_stale",
              "web",
              "wt_web_feature_auth_stale",
              "/tmp/station/web/feature-auth-stale",
              "main-agent",
              "codex",
            ].join("\t"),
          );
        }
        if (input.args?.[0] === "list-windows") {
          return tmuxCommandResult(input, `${collidingWindowName}\n`);
        }
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "station\t@new\t%new");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.openWorkspace({
        project,
        worktree: collidingWorktree,
        harness: "codex",
        layout: "agent-shell",
        sessionId: "ses_web_feature_auth",
      }),
    ).resolves.toMatchObject({
      target: {
        targetId: "tmux:station:@new:%new",
        worktreeId: collidingWorktree.id,
        providerData: {
          windowName: forcedWindowName,
          windowTarget: "station:@new",
          paneTarget: "%new",
        },
      },
    });

    expect(calls.map((call) => call.args)).toContainEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}",
      "-t",
      "station:",
      "-n",
      forcedWindowName,
      "-c",
      collidingWorktree.path,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "station:@new",
      "@station.worktree_id",
      collidingWorktree.id,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%new",
      "@station.role",
      "main-agent",
    ]);
    expect(calls.map((call) => call.args)).not.toContainEqual([
      "set-option",
      "-w",
      "-t",
      `station:${forcedWindowName}`,
      "@station.worktree_id",
      collidingWorktree.id,
    ]);
  });

  it("reuses an existing workbench pane by stored worktree path during name transitions", async () => {
    const calls: ExternalCommandInput[] = [];
    const transitionedWorktree = {
      ...worktree,
      id: "wt_web_feature_auth_7aa73790c8",
      branch: "feature/auth",
      path: "/tmp/station/web/feature-auth",
    };
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "list-windows") {
          return tmuxCommandResult(input, "web-feature-auth\n");
        }
        if (input.args?.[0] === "list-panes") {
          return tmuxCommandResult(
            input,
            [
              "station",
              "@old",
              "%old",
              "1",
              "0",
              "",
              "/tmp/station/web/feature-auth",
              "12345",
              "codex",
              "web-feature-auth",
              "ses_web_feature",
              "web",
              "wt_web_feature_auth",
              "/tmp/station/web/feature-auth",
              "main-agent",
              "codex",
            ].join("\t"),
          );
        }
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "station\t@old\t%old");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.openWorkspace({
        project,
        worktree: transitionedWorktree,
        harness: "codex",
        layout: "agent-shell",
        sessionId: "ses_web_feature",
      }),
    ).resolves.toMatchObject({
      target: {
        targetId: "tmux:station:@old:%old",
        worktreeId: transitionedWorktree.id,
        providerData: {
          windowName: "web-feature-auth",
          windowTarget: "station:@old",
          paneTarget: "%old",
        },
      },
    });

    expect(calls.map((call) => call.args?.[0])).not.toContain("new-window");
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "station:@old",
      "@station.worktree_id",
      transitionedWorktree.id,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%old",
      "@station.role",
      "main-agent",
    ]);
  });

  it("does not let cwd fallback override a stored worktree path mismatch", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "new-window") {
          return tmuxCommandResult(input, "station\t@fresh\t%fresh");
        }
        if (input.args?.[0] === "list-windows") {
          return tmuxCommandResult(input, "web-other\n");
        }
        if (input.args?.[0] === "list-panes") {
          return tmuxCommandResult(
            input,
            [
              "station",
              "@old",
              "%old",
              "1",
              "0",
              "",
              "/tmp/station/web/feature/nested",
              "12345",
              "codex",
              "web-feature",
              "ses_web_other",
              "web",
              "wt_web_other",
              "/tmp/station/web/other",
              "main-agent",
              "codex",
            ].join("\t"),
          );
        }
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "station\t@fresh\t%fresh");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.openWorkspace({
        project,
        worktree,
        harness: "codex",
        layout: "agent-shell",
        sessionId: "ses_web_feature",
      }),
    ).resolves.toMatchObject({
      target: {
        targetId: "tmux:station:@fresh:%fresh",
        worktreeId: worktree.id,
        providerData: {
          windowTarget: "station:@fresh",
          paneTarget: "%fresh",
        },
      },
    });

    expect(calls.map((call) => call.args)).toContainEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}",
      "-t",
      "station:",
      "-n",
      windowName,
      "-c",
      worktree.path,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "station:@fresh",
      "@station.worktree_path",
      worktree.path,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%fresh",
      "@station.role",
      "main-agent",
    ]);
    expect(calls.map((call) => call.args)).not.toContainEqual([
      "set-option",
      "-w",
      "-t",
      "station:@old",
      "@station.worktree_path",
      worktree.path,
    ]);
  });

  it("lists targets using an explicit tmux format", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(
          input,
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
            "main-agent",
            "codex",
          ].join("\t"),
        );
      },
    });

    await expect(provider.listTargets()).resolves.toEqual([
      expect.objectContaining({
        id: "tmux:station:@1:%2",
        worktreeId: "wt_web_feature",
        provider: "tmux",
      }),
    ]);
    expect(calls[0]?.args).toEqual([
      "list-panes",
      "-a",
      "-F",
      expect.stringContaining("#{session_name}"),
    ]);
    expect(calls[0]?.args).toEqual([
      "list-panes",
      "-a",
      "-F",
      expect.stringContaining("#{pane_current_command}"),
    ]);
  });

  it.each([
    ["macOS", "error connecting to /private/tmp/tmux-501/default (No such file or directory)"],
    ["Linux", "no server running on /tmp/tmux-1000/default"],
  ])("treats %s no-server output as empty topology without retry", async (_platform, stderr) => {
    let calls = 0;
    const provider = new TmuxProvider({
      runner: async () => {
        calls += 1;
        throw Object.assign(new Error("tmux has no server"), { code: 1, stderr });
      },
    });

    await expect(provider.listTargets()).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  it.each([
    ["permission failure", 1, "error connecting to /tmp/tmux-1000/default (Permission denied)"],
    ["a different exit code", 2, "no server running on /tmp/tmux-1000/default"],
    ["target-shaped stderr", 1, "can't find pane: %12"],
    ["additional stderr", 1, "warning: bad config\nno server running on /tmp/tmux-1000/default"],
    [
      "noisy macOS stderr",
      1,
      "warning: bad config\nerror connecting to /private/tmp/tmux-501/default (No such file or directory)",
    ],
  ])("does not normalize %s while listing targets", async (_case, code, stderr) => {
    let calls = 0;
    const provider = new TmuxProvider({
      runner: async () => {
        calls += 1;
        throw Object.assign(new Error("tmux list failed"), { code, stderr });
      },
    });

    await expect(provider.listTargets()).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_LIST_FAILED",
      provider: "tmux",
    });
    expect(calls).toBe(2);
  });

  it("maps stale target focus to a typed TerminalProviderError", async () => {
    const provider = new TmuxProvider({
      runner: async () => {
        throw Object.assign(new Error("can't find pane"), { code: 1, stderr: "can't find pane" });
      },
    });

    await expect(provider.focusTarget("tmux:station:@missing:%missing")).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      provider: "tmux",
    });
  });

  it("focuses the originating tmux client before selecting the workbench window and pane", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget("tmux:station:@1:%2", {
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => call.args)).toEqual([
      ["switch-client", "-c", "client_1", "-t", "station"],
      ["select-window", "-t", "station:@1"],
      ["select-pane", "-t", "%2"],
    ]);
  });

  it("resolves the popup focus client live when the origin omits clientId", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      runner: async (input) => {
        calls.push(input);
        const args = input.args ?? [];
        // The popup launcher publishes the originating client in this option;
        // the persistent popup can't pass it in the focus command directly.
        if (args[0] === "show-options" && args.includes("@station_popup_focus_client")) {
          return tmuxCommandResult(input, "client_live\n");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget("tmux:station:@1:%2", { origin: { provider: "tmux" } }),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => call.args)).toEqual([
      ["show-options", "-gqv", "@station_popup_focus_client"],
      ["switch-client", "-c", "client_live", "-t", "station"],
      ["select-window", "-t", "station:@1"],
      ["select-pane", "-t", "%2"],
    ]);
  });

  it("skips the client switch when no popup focus client is registered", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget("tmux:station:@1:%2", { origin: { provider: "tmux" } }),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => call.args)).toEqual([
      ["show-options", "-gqv", "@station_popup_focus_client"],
      ["select-window", "-t", "station:@1"],
      ["select-pane", "-t", "%2"],
    ]);
  });

  it("launches a structured harness plan in the primary agent pane", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.launchProcess?.({
        project,
        worktree,
        terminalTarget: {
          provider: "tmux",
          targetId: "tmux:station:@web-feature-login:%web-feature-login-main",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          confidence: "high",
          reason: "Fixture binding.",
          providerData: {
            paneTarget: "station:web-feature-login.0",
          },
        },
        agentEndpointId: "%web-feature-login-main",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: ["--cd", "/tmp/station/web/feature"],
          cwd: "/tmp/station/web/feature",
          env: {
            STATION_SESSION_ID: "ses_web_feature",
            STATION_TOKEN: "value with spaces",
          },
          mode: "interactive",
        },
      }),
    ).resolves.toMatchObject({
      started: true,
      terminalTargetId: "tmux:station:@web-feature-login:%web-feature-login-main",
      agentEndpointId: "%web-feature-login-main",
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["set-option", "-p", "-t", "station:web-feature-login.0", "remain-on-exit", "on"],
      [
        "respawn-pane",
        "-k",
        "-t",
        "station:web-feature-login.0",
        "-c",
        "/tmp/station/web/feature",
        "-e",
        "STATION_SESSION_ID=ses_web_feature",
        "-e",
        "STATION_TOKEN=value with spaces",
        "codex --cd '/tmp/station/web/feature'",
      ],
      [
        "display-message",
        "-p",
        "-t",
        "station:web-feature-login.0",
        "#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}",
      ],
    ]);
  });

  it("maps an immediately exited harness process to a typed launch error", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new TmuxProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "display-message") {
          return tmuxCommandResult(input, "1\t2\tcodex");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.launchProcess?.({
        project,
        worktree,
        terminalTarget: {
          provider: "tmux",
          targetId: "tmux:station:@web-feature-login:%web-feature-login-main",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          confidence: "high",
          reason: "Fixture binding.",
          providerData: {
            paneTarget: "station:web-feature-login.0",
          },
        },
        agentEndpointId: "%web-feature-login-main",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: [],
          cwd: "/tmp/station/web/feature",
          mode: "interactive",
        },
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_LAUNCH_EXITED",
      provider: "tmux",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      hint: expect.stringContaining("exit status 2"),
    });

    expect(calls.map((call) => call.args?.[0])).toEqual([
      "set-option",
      "respawn-pane",
      "display-message",
    ]);
  });

  it("aborts tmux subprocesses on timeout with a typed error", async () => {
    let aborted = false;
    const provider = new TmuxProvider({
      timeoutMs: 5,
      runner: async (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        }),
    });

    await expect(provider.listTargets()).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TMUX_TIMEOUT",
    });
    expect(aborted).toBe(true);
  });

  it("maps launch timeout to a typed terminal provider error", async () => {
    let aborted = false;
    const provider = new TmuxProvider({
      timeoutMs: 5,
      runner: async (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        }),
    });

    await expect(
      provider.launchProcess?.({
        project,
        worktree,
        terminalTarget: {
          provider: "tmux",
          targetId: "tmux:station:@web-feature-login:%web-feature-login-main",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          confidence: "high",
          reason: "Fixture binding.",
        },
        agentEndpointId: "%web-feature-login-main",
        launchPlan: {
          provider: "codex",
          command: "codex",
          args: [],
          cwd: "/tmp/station/web/feature",
          mode: "interactive",
        },
      }),
    ).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TMUX_TIMEOUT",
    });
    expect(aborted).toBe(true);
  });
});
