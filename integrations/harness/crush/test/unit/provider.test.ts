import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildHarnessLaunchRequest, HarnessRunObservation } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installCrushHooks } from "../../src/hooks";
import { createCrushHarnessProvider } from "../../src/provider";

const now = "2026-06-19T12:00:00.000Z";

describe("CrushHarnessProvider", () => {
  it("declares conservative Crush capabilities", () => {
    const provider = createCrushHarnessProvider();

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
      supportsModifiedEnterSoftNewline: false,
    });
  });

  it("checks crush --version for provider health", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createCrushHarnessProvider({
      command: "crush-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "crush version 1.2.3\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "crush",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        command: "crush --version succeeded",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("falls back to STATION_CRUSH_BIN when no command is configured", async () => {
    const previous = process.env.STATION_CRUSH_BIN;
    process.env.STATION_CRUSH_BIN = "crush-from-env";
    try {
      const provider = createCrushHarnessProvider();

      await expect(provider.buildLaunch(request())).resolves.toMatchObject({
        command: "crush-from-env",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.STATION_CRUSH_BIN;
      } else {
        process.env.STATION_CRUSH_BIN = previous;
      }
    }
  });

  it("reports Crush hook diagnostics from provider config", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "station-crush-provider-")));
    const crushConfigPath = join(root, ".crush.json");
    const hookScriptPath = join(root, ".crush", "hooks", "station-crush-hook.sh");
    const configPath = join(root, "station.config.toml");
    const observerSocketPath = join(root, "observer.sock");
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");
    await installCrushHooks({
      crushConfigPath,
      hookScriptPath,
      stationConfigPath: configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
    });
    const provider = createCrushHarnessProvider({
      installHooks: true,
      configPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
    });
    const previousCwd = process.cwd();

    process.chdir(root);
    try {
      await expect(provider.doctorChecks()).resolves.toContainEqual(
        expect.objectContaining({
          name: "crush-hooks",
          status: "ok",
        }),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("discovers and classifies terminal-bound runs", async () => {
    const provider = createCrushHarnessProvider();

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
              harnessProvider: "crush",
              currentCommand: "crush",
            },
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "crush:tmux:station:@1:%2",
        provider: "crush",
        worktreeId: "wt_web_task",
        state: "unknown",
        confidence: "low",
      }),
    ]);

    await expect(
      provider.classifyRun(run(), {
        projects: [],
        worktrees: [],
        terminalTargets: [],
      }),
    ).resolves.toMatchObject({
      provider: "crush",
      status: {
        value: "unknown",
        confidence: "low",
      },
    });
  });

  it("ingests Crush hook events", async () => {
    const provider = createCrushHarnessProvider();

    const observations = await provider.ingestEvent?.(
      {
        provider: "crush",
        event: {
          event: "PreToolUse",
          session_id: "crush_session_1",
          cwd: "/tmp/station/web/task",
          tool_name: "bash",
          station_project_id: "web",
          station_worktree_id: "wt_web_task",
          station_worktree_path: "/tmp/station/web/task",
          station_session_id: "ses_web_task",
          station_terminal_target_id: "tmux:station:@1:%2",
        },
        observedAt: now,
      },
      {
        projects: [],
        worktrees: [
          {
            id: "wt_web_task",
            provider: "worktrunk",
            projectId: "web",
            branch: "task",
            path: "/tmp/station/web/task",
            state: "exists",
            source: "worktrunk",
            observedAt: now,
          },
        ],
        terminalTargets: [],
      },
    );

    expect(observations).toEqual([
      expect.objectContaining({
        provider: "crush",
        rawEventType: "PreToolUse",
      }),
    ]);
    expect(observations?.[0]).not.toHaveProperty("status");
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
    mode: "interactive",
  };
}

function run(): HarnessRunObservation {
  return {
    id: "crush:tmux:station:@1:%2",
    provider: "crush",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to Crush; no reliable lifecycle signal yet.",
    observedAt: now,
  };
}
