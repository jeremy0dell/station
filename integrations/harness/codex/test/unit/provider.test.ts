import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BuildHarnessLaunchRequest,
  HarnessRunObservation,
  RawHarnessEvent,
} from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installCodexHooks } from "../../src/hooks";
import { CodexHarnessProvider } from "../../src/provider";

const now = "2026-05-21T12:00:00.000Z";

describe("CodexHarnessProvider", () => {
  it("declares real Codex capabilities", () => {
    const provider = new CodexHarnessProvider();

    expect(provider.capabilities()).toEqual({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: true,
      canExposeApprovalState: true,
      supportsModifiedEnterSoftNewline: true,
    });
  });

  it("advertises resume only when configured", () => {
    expect(new CodexHarnessProvider().capabilities().canResume).toBe(false);
    expect(new CodexHarnessProvider({ resume: true }).capabilities().canResume).toBe(true);
  });

  it("hooksStatus reports requested:false / installed:false when hooks are not enabled", async () => {
    const provider = new CodexHarnessProvider({ now: () => new Date(now) });
    await expect(provider.hooksStatus()).resolves.toMatchObject({
      provider: "codex",
      requested: false,
      installed: false,
    });
  });

  it("checks codex login status for provider health", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = new CodexHarnessProvider({
      command: "codex-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "Logged in with ChatGPT\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "codex",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        auth: "codex login status succeeded",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["login", "status"]]);
  });

  it("maps health failures to typed harness provider health", async () => {
    const provider = new CodexHarnessProvider({
      command: "missing-codex",
      now: () => new Date(now),
      runner: async () => {
        throw Object.assign(new Error("not found"), {
          code: "ENOENT",
          stderr: "missing-codex: command not found",
        });
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "codex",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        tag: "HarnessProviderError",
        code: "HARNESS_CODEX_UNAVAILABLE",
        provider: "codex",
      },
    });
  });

  it("applies provider launch defaults and discovers terminal-bound runs", async () => {
    const provider = new CodexHarnessProvider({
      command: "codex-test",
      profile: "team-default",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      installHooks: true,
      noAltScreen: true,
      now: () => new Date(now),
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      args: [
        "--cd",
        "/tmp/station/web/task",
        "--profile",
        "station",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "--no-alt-screen",
      ],
    });

    await expect(
      provider.discoverRuns({
        projects: [],
        worktrees: [],
        terminalTargets: [
          {
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
            harnessBinding: {
              role: "main-agent",
              harnessProvider: "codex",
              currentCommand: "codex",
            },
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "codex",
        worktreeId: "wt_web_task",
        state: "unknown",
        confidence: "low",
      }),
    ]);
  });

  it("applies provider yolo permission mode to launch plans", async () => {
    const provider = new CodexHarnessProvider({
      permissionMode: "yolo",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      args: ["--cd", "/tmp/station/web/task", "--dangerously-bypass-approvals-and-sandbox"],
      providerData: {
        permissionMode: "yolo",
      },
    });
  });

  it("uses observer hook paths when checking installed hook diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-provider-"));
    const codexHome = join(root, "codex-home");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const stationConfigPath = join(root, "station.config.toml");
    const observerSocketPath = join(root, "run", "observer.sock");
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");

    await installCodexHooks({
      hookScriptPath,
      stationConfigPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      env: { CODEX_HOME: codexHome },
    });

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const provider = new CodexHarnessProvider({
        command: "codex-test",
        installHooks: true,
        observerSocketPath,
        stateDir,
        hookSpoolDir,
        autoStartFromHooks: false,
        runner: async (input) => result(input, "Logged in with ChatGPT\n"),
      });

      await expect(provider.doctorChecks({ stationConfigPath })).resolves.toContainEqual(
        expect.objectContaining({
          name: "codex-hooks",
          status: "ok",
        }),
      );
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("classifies and ingests Codex observations through provider-local parsing", async () => {
    const provider = new CodexHarnessProvider({ now: () => new Date(now) });

    await expect(
      provider.classifyRun(run(), {
        projects: [],
        worktrees: [],
        terminalTargets: [],
      }),
    ).resolves.toMatchObject({
      status: {
        value: "unknown",
        confidence: "low",
      },
    });

    await expect(provider.ingestEvent?.(event(), eventContext())).resolves.toEqual([
      expect.objectContaining({
        provider: "codex",
        worktreeId: "wt_web_task",
        rawEventType: "SessionStart",
      }),
    ]);
  });
});

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function request(): BuildHarnessLaunchRequest {
  const target = eventContext().terminalTargets[0];
  if (target === undefined) {
    throw new Error("Codex provider fixture is missing a terminal target.");
  }
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
    terminalTarget: target,
    mode: "interactive",
    sessionId: "ses_web_task",
  };
}

function run(): HarnessRunObservation {
  return {
    id: "codex:tmux:station:@1:%2",
    provider: "codex",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to Codex; no reliable lifecycle signal yet.",
    observedAt: now,
  };
}

function event(): RawHarnessEvent {
  return {
    provider: "codex",
    observedAt: now,
    event: {
      session_id: "codex_session_123",
      transcript_path: null,
      cwd: "/tmp/station/web/task",
      hook_event_name: "SessionStart",
      model: "gpt-5.4-codex",
      permission_mode: "default",
      source: "startup",
    },
  };
}

function eventContext() {
  return {
    projects: [],
    worktrees: [
      {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
        state: "exists" as const,
        source: "worktrunk" as const,
        observedAt: now,
      },
    ],
    terminalTargets: [
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: "open" as const,
        cwd: "/tmp/station/web/task",
        confidence: "high" as const,
        reason: "tmux pane has station identity binding.",
        observedAt: now,
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "codex",
        },
      },
    ],
  };
}
