import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";

const now = "2026-05-20T12:00:00.000Z";

const project = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
  },
};

describe("fake providers", () => {
  it("returns deterministic fake worktree observations scoped to the requested project", async () => {
    const provider = new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({ id: "wt_web_main", projectId: "web", branch: "main", now }),
        createFakeWorktree({ id: "wt_api_main", projectId: "api", branch: "main", now }),
      ],
    });

    await expect(provider.listWorktrees(project)).resolves.toEqual([
      expect.objectContaining({
        id: "wt_web_main",
        projectId: "web",
        observedAt: now,
      }),
    ]);
    await expect(provider.health()).resolves.toMatchObject({
      providerId: "fake-worktree",
      providerType: "worktree",
      status: "healthy",
      lastCheckedAt: now,
    });
  });

  it("returns deterministic fake terminal and harness observations", async () => {
    const terminal = new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "term_web_main",
          projectId: "web",
          worktreeId: "wt_web_main",
          harnessRunId: "run_web_main",
          now,
        }),
      ],
    });
    const harness = new FakeHarnessProvider({
      now,
      runs: [
        createFakeHarnessRun({
          id: "run_web_main",
          projectId: "web",
          worktreeId: "wt_web_main",
          state: "working",
          now,
        }),
      ],
    });

    await expect(terminal.listTargets()).resolves.toEqual([
      expect.objectContaining({
        id: "term_web_main",
        provider: "fake-terminal",
        observedAt: now,
      }),
    ]);
    await expect(
      harness.discoverRuns({ projects: [project], worktrees: [], terminalTargets: [] }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "run_web_main",
        provider: "fake-harness",
        state: "working",
        observedAt: now,
      }),
    ]);
  });

  it("records terminal launch plans against the primary agent target", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const worktree = createFakeWorktree({
      id: "wt_web_task",
      projectId: "web",
      branch: "task",
      now,
    });
    const opened = await terminal.openWorkspace({
      project,
      worktree,
      harness: "fake-harness",
      layout: "agent-shell",
      sessionId: "ses_web_task",
    });
    const harness = new FakeHarnessProvider({ now });
    const launchPlan = await harness.buildLaunch({
      project,
      worktree,
      sessionId: "ses_web_task",
      initialPrompt: "Do the deterministic fake task.",
      mode: "interactive",
      profile: "default",
    });

    await expect(
      terminal.launchProcess?.({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      }),
    ).resolves.toMatchObject({
      started: true,
      terminalTargetId: opened.target.targetId,
      agentEndpointId: opened.agentEndpointId,
    });
    expect(terminal.snapshot().launches).toEqual([
      expect.objectContaining({
        agentEndpointId: opened.agentEndpointId,
        launchPlan: expect.objectContaining({
          env: expect.objectContaining({
            STATION_SESSION_ID: "ses_web_task",
          }),
          providerData: expect.objectContaining({
            initialPromptProvided: true,
            profile: "default",
          }),
        }),
      }),
    ]);
  });

  it("injects typed provider failures without changing fixture data", async () => {
    const provider = new FakeTerminalProvider({
      now,
      targets: [createFakeTerminalTarget({ id: "term_web_main", now })],
      failures: {
        listTargets: {
          tag: "TerminalProviderError",
          code: "FAKE_TERMINAL_LIST_FAILED",
          message: "The fake terminal provider failed to list targets.",
          provider: "fake-terminal",
        },
      },
    });

    await expect(provider.listTargets()).rejects.toMatchObject({
      tag: "TerminalProviderError",
      code: "FAKE_TERMINAL_LIST_FAILED",
      provider: "fake-terminal",
    });
    expect(provider.snapshot().targets).toHaveLength(1);
  });

  it("records worktree remove, terminal close, and harness stop mutations", async () => {
    const worktree = new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_cleanup",
          projectId: "web",
          branch: "cleanup",
          now,
        }),
      ],
    });
    const terminal = new FakeTerminalProvider({
      now,
      targets: [
        createFakeTerminalTarget({
          id: "term_web_cleanup",
          projectId: "web",
          worktreeId: "wt_web_cleanup",
          sessionId: "ses_web_cleanup",
          harnessRunId: "run_web_cleanup",
          now,
        }),
      ],
    });
    const harness = new FakeHarnessProvider({
      now,
      runs: [
        createFakeHarnessRun({
          id: "run_web_cleanup",
          projectId: "web",
          worktreeId: "wt_web_cleanup",
          sessionId: "ses_web_cleanup",
          state: "working",
          now,
        }),
      ],
    });

    await expect(
      harness.stop?.({ runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true }),
    ).resolves.toMatchObject({ runId: "run_web_cleanup", stopped: true });
    await expect(terminal.closeTarget("term_web_cleanup")).resolves.toBeUndefined();
    await expect(
      worktree.removeWorktree({
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        force: true,
      }),
    ).resolves.toEqual({ worktreeId: "wt_web_cleanup", removed: true });

    expect(harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(harness.snapshot().runs).toEqual([
      expect.objectContaining({
        id: "run_web_cleanup",
        state: "exited",
      }),
    ]);
    expect(terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(terminal.snapshot().targets).toEqual([]);
    expect(worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        force: true,
      },
    ]);
    expect(worktree.snapshot().worktrees).toEqual([]);
  });
});
