import { createHash } from "node:crypto";
import type { ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  tmuxListTargetsFormat,
  tmuxPaneProofFormat,
  tmuxPrimaryPaneIdentityFormat,
} from "../../src/parse";
import { TmuxProvider } from "../../src/provider";
import { buildWorkbenchWindowName } from "../../src/topology";
import { tmuxCommandResult } from "../support/commands";

const proofSocketPath = "/tmp/station-provider-test.sock";
const proofGeneration = createHash("sha256")
  .update(
    JSON.stringify({
      socketPath: proofSocketPath,
      device: "1",
      inode: "2",
      serverPid: 10,
      serverStartToken: "server",
    }),
  )
  .digest("hex");

function mutableTargetId(sessionId = "$1", windowId = "@1", paneId = "%2") {
  return `tmux:${proofGeneration}:${sessionId}:${windowId}:${paneId}`;
}

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
    const provider = createTestProvider();

    expect(provider.id).toBe("tmux");
    expect(provider.capabilities()).toEqual({
      canOpenWorkspace: true,
      canFocusTarget: true,
      canCloseTarget: true,
      canCaptureOutput: true,
      canSendInput: true,
      canPersistIdentityBinding: true,
      canLaunchProcessPersistently: true,
      canDisplayPopup: true,
    });
  });

  it("routes ordinary provider commands through the configured endpoint", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      config: { workbenchSocketPath: proofSocketPath },
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, input.args?.includes("-V") ? "tmux 3.5" : "");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(provider.listTargets()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(
      calls.every((call) => call.args?.slice(0, 2).join(" ") === `-S ${proofSocketPath}`),
    ).toBe(true);
    expect(
      calls.every(
        (call) =>
          call.unsetEnv?.includes("TMUX") === true && call.unsetEnv?.includes("TMUX_PANE") === true,
      ),
    ).toBe(true);
  });

  it("keeps provider health errors lean while command evidence stays internal", async () => {
    const provider = createTestProvider({
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
    const provider = createTestProvider({
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
        targetId: mutableTargetId("$1", "@7", "%8"),
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
      ["display-message", "-p", "-t", paneTarget, tmuxPrimaryPaneIdentityFormat],
    ]);
  });

  it("appends new workbench windows to an existing tmux session", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
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
        targetId: mutableTargetId("$1", "@9", "%10"),
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
        tmuxPrimaryPaneIdentityFormat,
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
      ["display-message", "-p", "-t", "%10", tmuxPrimaryPaneIdentityFormat],
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
    const provider = createTestProvider({
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
              "$1",
              "@12",
              "%13",
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
        targetId: mutableTargetId("$1", "@20", "%30"),
        worktreeId: collidingWorktree.id,
        providerData: {
          windowName: forcedWindowName,
          windowTarget: "station:@20",
          paneTarget: "%30",
        },
      },
    });

    expect(calls.map((call) => call.args)).toContainEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      tmuxPrimaryPaneIdentityFormat,
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
      "station:@20",
      "@station.worktree_id",
      collidingWorktree.id,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%30",
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

  it("keeps a generation-qualified identity when every pane is stale", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "list-panes") {
          return tmuxCommandResult(
            input,
            [
              "station",
              "$1",
              "@1",
              "%2",
              "0",
              "1",
              "0",
              "/tmp/station/web/feature",
              "100",
              "zsh",
              "stale-window",
              "ses_stale",
              "web",
              "wt_stale",
              "/tmp/station/web/feature",
              "main-agent",
              "codex",
            ].join("\t"),
          );
        }
        return tmuxCommandResult(input, "");
      },
    });

    const [target] = await provider.listTargets();
    expect(target?.id).toBe(mutableTargetId("$1", "@1", "%2"));
    await expect(provider.closeTarget(target?.id ?? "")).resolves.toBeUndefined();
    expect(calls.at(-1)?.args?.[0]).toBe("if-shell");
  });

  it("reuses an existing workbench pane by stored worktree path during name transitions", async () => {
    const calls: ExternalCommandInput[] = [];
    const transitionedWorktree = {
      ...worktree,
      id: "wt_web_feature_auth_7aa73790c8",
      branch: "feature/auth",
      path: "/tmp/station/web/feature-auth",
    };
    const provider = createTestProvider({
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
              "$1",
              "@10",
              "%11",
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
          return tmuxCommandResult(input, "station\t@10\t%11");
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
        targetId: mutableTargetId("$1", "@10", "%11"),
        worktreeId: transitionedWorktree.id,
        providerData: {
          windowName: "web-feature-auth",
          windowTarget: "station:@10",
          paneTarget: "%11",
        },
      },
    });

    expect(calls.map((call) => call.args?.[0])).not.toContain("new-window");
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-w",
      "-t",
      "station:@10",
      "@station.worktree_id",
      transitionedWorktree.id,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%11",
      "@station.role",
      "main-agent",
    ]);
  });

  it("does not let cwd fallback override a stored worktree path mismatch", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
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
              "$1",
              "@14",
              "%15",
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
        targetId: mutableTargetId("$1", "@20", "%30"),
        worktreeId: worktree.id,
        providerData: {
          windowTarget: "station:@20",
          paneTarget: "%30",
        },
      },
    });

    expect(calls.map((call) => call.args)).toContainEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      tmuxPrimaryPaneIdentityFormat,
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
      "station:@20",
      "@station.worktree_path",
      worktree.path,
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      "set-option",
      "-p",
      "-t",
      "%30",
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

  it("does not create a duplicate window when existing-pane output is malformed", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "list-panes") {
          return tmuxCommandResult(input, "station\tmalformed");
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
    ).rejects.toMatchObject({ code: "TERMINAL_OPEN_FAILED", provider: "tmux" });
    expect(calls.map((call) => call.args?.[0])).not.toContain("new-window");
  });

  it("lists targets using an explicit tmux format", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(
          input,
          [
            "station",
            "$1",
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
        );
      },
    });

    await expect(provider.listTargets()).resolves.toEqual([
      expect.objectContaining({
        id: mutableTargetId("$1", "@1", "%2"),
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
    const provider = createTestProvider({
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
    const provider = createTestProvider({
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

  it("refuses an unqualified target identity before terminal mutation", async () => {
    const provider = createTestProvider({
      runner: async () => {
        throw Object.assign(new Error("can't find pane"), { code: 1, stderr: "can't find pane" });
      },
    });

    await expect(provider.focusTarget("tmux:station:@missing:%missing")).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_INVALID",
      provider: "tmux",
    });
  });

  it("focuses the originating tmux client before selecting the workbench window and pane", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget(mutableTargetId(), {
        origin: {
          provider: "tmux",
          clientId: "client_1",
        },
      }),
    ).resolves.toBeUndefined();

    const mutation = calls.at(-1)?.args?.join(" ") ?? "";
    expect(mutation).toContain('"switch-client" "-c" "client_1"');
    expect(mutation).toContain('"select-window"');
    expect(mutation).toContain('"select-pane"');
    expect(calls.at(-1)?.args?.[0]).toBe("if-shell");
  });

  it("resolves the popup focus client live when the origin omits clientId", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
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
      provider.focusTarget(mutableTargetId(), { origin: { provider: "tmux" } }),
    ).resolves.toBeUndefined();

    expect(calls[0]?.args).toEqual(["show-options", "-gqv", "@station_popup_focus_client"]);
    const mutation = calls.at(-1)?.args?.join(" ") ?? "";
    expect(mutation).toContain('"switch-client" "-c" "client_live"');
    expect(mutation).toContain('"select-window"');
    expect(mutation).toContain('"select-pane"');
  });

  it("skips the client switch when no popup focus client is registered", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      runner: async (input) => {
        calls.push(input);
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget(mutableTargetId(), { origin: { provider: "tmux" } }),
    ).resolves.toBeUndefined();

    expect(calls[0]?.args).toEqual(["show-options", "-gqv", "@station_popup_focus_client"]);
    expect(calls.at(-1)?.args?.[0]).toBe("if-shell");
    expect(calls.at(-1)?.args?.join(" ")).toContain('"select-window"');
  });

  it("keeps popup client lookup on the invoking endpoint when workbench is configured", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      config: { workbenchSocketPath: proofSocketPath },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "show-options") {
          return tmuxCommandResult(input, "client_invoking\n");
        }
        return tmuxCommandResult(input, "");
      },
    });

    await expect(
      provider.focusTarget(mutableTargetId(), { origin: { provider: "tmux" } }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.args).toEqual(["show-options", "-gqv", "@station_popup_focus_client"]);
    expect(calls.at(-1)?.args?.slice(0, 2)).toEqual(["-S", proofSocketPath]);
  });

  it("launches a structured harness plan in the primary agent pane", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
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
          targetId: mutableTargetId(),
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
      terminalTargetId: mutableTargetId(),
      agentEndpointId: "%web-feature-login-main",
    });

    expect(calls.map((call) => call.args?.[0])).toEqual(["if-shell", "if-shell"]);
    expect(calls[0]?.args?.join(" ")).toContain('"set-option"');
    expect(calls[0]?.args?.join(" ")).toContain('"respawn-pane"');
    expect(calls[0]?.args?.join(" ")).toContain("STATION_TOKEN=value with spaces");
    expect(calls[1]?.args?.join(" ")).toContain("pane_dead");
  });

  it("maps an immediately exited harness process to a typed launch error", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createTestProvider({
      clock: { now: () => new Date(now) },
      runner: async (input) => {
        calls.push(input);
        if (input.args?.[0] === "if-shell" && input.args.join(" ").includes("pane_dead")) {
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
          targetId: mutableTargetId(),
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

    expect(calls.map((call) => call.args?.[0])).toEqual(["if-shell", "if-shell"]);
  });

  it("aborts tmux subprocesses on timeout with a typed error", async () => {
    let aborted = false;
    const provider = createTestProvider({
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
    const provider = createTestProvider({
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
          targetId: mutableTargetId(),
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

function createTestProvider(
  options: ConstructorParameters<typeof TmuxProvider>[0] = {},
): TmuxProvider {
  const runner = options.runner;
  const identities = new Map<
    string,
    { sessionId: string; sessionName: string; windowId: string; paneId: string }
  >();
  const stableWindows = new Map<string, string>();
  const stablePanes = new Map<string, string>();
  const stableWindow = (value: string) => {
    if (/^@\d+$/u.test(value)) return value;
    const existing = stableWindows.get(value);
    if (existing !== undefined) return existing;
    const next = `@${20 + stableWindows.size}`;
    stableWindows.set(value, next);
    return next;
  };
  const stablePane = (value: string) => {
    if (/^%\d+$/u.test(value)) return value;
    const existing = stablePanes.get(value);
    if (existing !== undefined) return existing;
    const next = `%${30 + stablePanes.size}`;
    stablePanes.set(value, next);
    return next;
  };
  return new TmuxProvider({
    ...options,
    socketEvidence: () => ({ device: "1", inode: "2" }),
    processEvidence: {
      read: (pid) => {
        if (pid === 10) return { pid, parentPid: 1, startToken: "server" };
        if (pid === 100) return { pid, parentPid: 1, startToken: "pane" };
        return undefined;
      },
    },
    ...(runner === undefined
      ? {}
      : {
          runner: async (input: ExternalCommandInput) => {
            const args = input.args ?? [];
            if (args.at(-1) === tmuxPaneProofFormat) {
              const targetIndex = args.indexOf("-t");
              const paneId = targetIndex < 0 ? "%2" : (args[targetIndex + 1] ?? "%2");
              const identity = identities.get(paneId) ?? {
                sessionId: "$1",
                sessionName: "station",
                windowId: "@1",
                paneId,
              };
              return tmuxCommandResult(
                input,
                [
                  proofSocketPath,
                  "10",
                  identity.sessionId,
                  identity.sessionName,
                  identity.windowId,
                  identity.paneId,
                  "100",
                  "",
                  "",
                ].join("\t"),
              );
            }
            const result = await runner(input);
            if (args.includes(tmuxPrimaryPaneIdentityFormat)) {
              const fields = result.stdout.trim().split("\t");
              const sessionName = fields.length === 3 ? fields[0] : fields[1];
              const originalWindow = fields.length === 3 ? fields[1] : fields[2];
              const originalPane = fields.length === 3 ? fields[2] : fields[3];
              if (
                sessionName !== undefined &&
                originalWindow !== undefined &&
                originalPane !== undefined
              ) {
                const identity = {
                  sessionId: "$1",
                  sessionName,
                  windowId: stableWindow(originalWindow),
                  paneId: stablePane(originalPane),
                };
                identities.set(identity.paneId, identity);
                return tmuxCommandResult(
                  input,
                  [
                    identity.sessionId,
                    identity.sessionName,
                    identity.windowId,
                    identity.paneId,
                  ].join("\t"),
                );
              }
            }
            return result;
          },
        }),
  });
}
