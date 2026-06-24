import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildHarnessLaunchRequest } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { ScriptedAgentHarnessProvider } from "../../src/provider";

const now = "2026-05-20T12:00:00.000Z";

describe("ScriptedAgentHarnessProvider", () => {
  it("reports capabilities, health, launch plans, discovery, classification, and event ingestion", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-scripted-provider-"));
    const stateDir = join(root, "scripted");
    const runsDir = join(stateDir, "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, "run_web_task.jsonl"),
      [
        JSON.stringify({
          type: "started",
          at: now,
          runId: "run_web_task",
          projectId: "web",
          worktreeId: "wt_web_task",
          sessionId: "ses_web_task",
          pid: 1234,
        }),
        JSON.stringify({
          type: "activity",
          at: "2026-05-20T12:00:02.000Z",
          runId: "run_web_task",
          message: "Editing task.txt.",
        }),
      ].join("\n"),
    );

    const provider = new ScriptedAgentHarnessProvider({
      stateDir,
      runnerPath: "/tmp/station/scripted-agent.mjs",
      nodeCommand: "/usr/local/bin/node",
      now: () => new Date("2026-05-20T12:00:03.000Z"),
    });

    expect(provider.capabilities()).toMatchObject({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: true,
      canRunNonInteractive: true,
    });
    await expect(provider.health()).resolves.toMatchObject({
      providerId: "scripted",
      providerType: "harness",
      status: "healthy",
    });

    const plan = await provider.buildLaunch(launchRequest(root));
    expect(plan).toMatchObject({
      provider: "scripted",
      command: "/usr/local/bin/node",
      cwd: join(root, "worktree"),
    });

    const runs = await provider.discoverRuns({
      projects: [launchRequest(root).project],
      worktrees: [launchRequest(root).worktree],
      terminalTargets: [],
    });
    expect(runs).toEqual([
      expect.objectContaining({
        id: "run_web_task",
        provider: "scripted",
        projectId: "web",
        worktreeId: "wt_web_task",
      }),
    ]);

    const discoveredRun = runs[0];
    if (discoveredRun === undefined) {
      throw new Error("Expected scripted provider to discover a run.");
    }
    await expect(
      provider.classifyRun(discoveredRun, {
        projects: [launchRequest(root).project],
        worktrees: [launchRequest(root).worktree],
        terminalTargets: [],
      }),
    ).resolves.toMatchObject({
      status: {
        value: "working",
        confidence: "medium",
        reason: "Editing task.txt.",
      },
    });

    await expect(
      provider.ingestEvent?.(
        {
          provider: "scripted",
          observedAt: now,
          event: {
            type: "attention",
            at: now,
            runId: "run_web_task",
            worktreeId: "wt_web_task",
            message: "Approval requested.",
          },
        },
        { projects: [], worktrees: [], terminalTargets: [] },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        status: expect.objectContaining({
          value: "needs_attention",
          confidence: "high",
        }),
      }),
    ]);
  });
});

function launchRequest(root: string): BuildHarnessLaunchRequest {
  return {
    project: {
      id: "web",
      label: "web",
      root,
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
      path: join(root, "worktree"),
      state: "exists",
      source: "worktrunk",
      observedAt: now,
    },
    mode: "interactive",
  };
}
