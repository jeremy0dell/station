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
import { installCursorHooks } from "../../src/hooks";
import { createCursorHarnessProvider } from "../../src/provider";

const now = "2026-06-03T12:00:00.000Z";

describe("CursorHarnessProvider", () => {
  it("declares hook-only Cursor capabilities", () => {
    const provider = createCursorHarnessProvider();

    expect(provider.capabilities()).toEqual({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: false,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: false,
    });
  });

  it("advertises resume only when configured", () => {
    expect(createCursorHarnessProvider().capabilities().canResume).toBe(false);
    expect(createCursorHarnessProvider({ resume: true }).capabilities().canResume).toBe(true);
  });

  it("checks agent --version for provider health", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createCursorHarnessProvider({
      command: "agent-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "2026.06.02-8c11d9f\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "cursor",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        command: "agent --version succeeded",
        observation: "hooks",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("uses observer hook paths when checking installed hook diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-provider-"));
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    const stationConfigPath = join(root, "station.config.toml");
    const observerSocketPath = join(root, "run", "observer.sock");
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");

    await installCursorHooks({
      hookScriptPath,
      stationConfigPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      homeDir: root,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const provider = createCursorHarnessProvider({
        installHooks: true,
        configPath: stationConfigPath,
        observerSocketPath,
        stateDir,
        hookSpoolDir,
        autoStartFromHooks: false,
      });

      await expect(provider.doctorChecks()).resolves.toContainEqual(
        expect.objectContaining({
          name: "cursor-hooks",
          status: "ok",
        }),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("launches interactive Cursor agent with STATION correlation env", async () => {
    const provider = createCursorHarnessProvider({
      command: "agent-test",
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      provider: "cursor",
      command: "agent-test",
      args: ["--workspace", "/tmp/station/web/task"],
      cwd: "/tmp/station/web/task",
      env: {
        STATION_HARNESS_PROVIDER: "cursor",
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_SESSION_ID: "ses_web_task",
        STATION_TERMINAL_PROVIDER: "tmux",
        STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
      },
      providerData: {
        interactive: true,
        observation: "hooks",
        terminalTargetId: "tmux:station:@1:%2",
      },
    });
  });

  it("launches interactive Cursor resume with the native session id", async () => {
    const provider = createCursorHarnessProvider({
      command: "agent-test",
      resume: true,
    });

    await expect(
      provider.buildLaunch({
        ...request(),
        resume: {
          target: { kind: "native-session", id: "cursor_session_123" },
          previousSessionId: "ses_web_task",
          recoveryHandleId: "rec_cursor",
        },
      }),
    ).resolves.toMatchObject({
      args: ["--workspace", "/tmp/station/web/task", "--resume", "cursor_session_123"],
      providerData: {
        resume: true,
        resumeTargetKind: "native-session",
      },
    });
  });

  it("discovers terminal-bound Cursor runs", async () => {
    const provider = createCursorHarnessProvider();

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
              harnessProvider: "cursor",
              currentCommand: "agent",
            },
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "cursor:tmux:station:@1:%2",
        provider: "cursor",
        worktreeId: "wt_web_task",
        state: "unknown",
        confidence: "low",
      }),
    ]);
  });

  it("classifies and ingests Cursor observations through provider-local parsing", async () => {
    const provider = createCursorHarnessProvider({ now: () => new Date(now) });

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
        provider: "cursor",
        worktreeId: "wt_web_task",
        rawEventType: "sessionStart",
        status: expect.objectContaining({
          value: "starting",
        }),
      }),
    ]);
  });

  it("reports a high-confidence exit as a harness_event (Cursor source override)", async () => {
    const provider = createCursorHarnessProvider({ now: () => new Date(now) });

    await expect(
      provider.classifyRun(
        { ...run(), state: "exited", confidence: "high", reason: "agent exited" },
        { projects: [], worktrees: [], terminalTargets: [] },
      ),
    ).resolves.toMatchObject({
      status: {
        value: "exited",
        confidence: "high",
        source: "harness_event",
      },
    });
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
    throw new Error("Cursor provider fixture is missing a terminal target.");
  }
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "cursor",
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
    id: "cursor:tmux:station:@1:%2",
    provider: "cursor",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to Cursor; no reliable lifecycle signal yet.",
    observedAt: now,
  };
}

function event(): RawHarnessEvent {
  return {
    provider: "cursor",
    observedAt: now,
    event: {
      hook_event_name: "sessionStart",
      session_id: "cursor_session_123",
      workspace_roots: ["/tmp/station/web/task"],
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
          harnessProvider: "cursor",
        },
      },
    ],
  };
}
