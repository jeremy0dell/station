import type { StationConfig } from "@station/config";
import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessProvider,
  TerminalIntent,
  TerminalIntentReceipt,
} from "@station/contracts";
import { createCursorHarnessProvider } from "@station/cursor";
import { createPiHarnessProvider } from "@station/pi";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { createFeatureFlagEvaluator } from "../../src/features/evaluator";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
  type TerminalIntentRunner,
} from "../../src/internal";

const now = "2026-05-21T12:00:00.000Z";

describe("session command vertical slice", () => {
  it("creates a session, launches the primary agent target, reconciles, and focuses it", async () => {
    const harness = new FakeHarnessProvider({
      now,
      runs: [
        createFakeHarnessRun({
          id: "run_web_feature",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          state: "idle",
          now,
        }),
      ],
    });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      terminal,
      harness,
      sessionIds: ["ses_web_feature"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
          profile: "default",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: true,
          origin: {
            provider: "tmux",
            clientId: "client_1",
          },
        },
        initialPrompt: "Start the feature.",
      },
    });
    await fixture.queue.drain();

    expect(receipt).toMatchObject({ accepted: true, status: "accepted" });
    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(terminal.snapshot().focused).toEqual(["term_fake"]);
    expect(terminal.snapshot().focusContexts).toEqual([
      { origin: { provider: "tmux", clientId: "client_1" } },
    ]);
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_web_feature",
        projectId: "web",
        worktreeId: "wt_web_feature",
      }),
    ]);
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      sessionId: "ses_web_feature",
      state: "idle",
    });
    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).map(
        (event) => event.type,
      ),
    ).toEqual(["command.accepted", "command.started", "session.created", "command.succeeded"]);
    expect(await fixture.persistence.listEvents({ type: "session.created" })).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "session.created",
          session: expect.objectContaining({
            id: "ses_web_feature",
          }),
        }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("passes the opened terminal target into harness launch construction", async () => {
    const harness = new CapturingHarnessProvider({ now });
    const fixture = createFixture({
      terminal: new FakeTerminalProvider({ now }),
      harness,
      sessionIds: ["ses_web_feature"],
    });

    await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
        },
      },
    });
    await fixture.queue.drain();

    expect(harness.lastBuildRequest?.terminalTarget).toMatchObject({
      id: "term_fake",
      provider: "fake-terminal",
      projectId: "web",
      worktreeId: "wt_web_feature",
      sessionId: "ses_web_feature",
      state: "open",
    });
    fixture.sqlite.close();
  });

  it("submits session.create launch work through the terminal intent runner seam", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        openWorkspace: {
          tag: "TerminalProviderError",
          code: "DIRECT_OPEN_SHOULD_NOT_RUN",
          message: "Direct terminal open should not run from the handler.",
          provider: "fake-terminal",
        },
      },
    });
    const harness = new FakeHarnessProvider({
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "DIRECT_BUILD_SHOULD_NOT_RUN",
          message: "Direct harness build should not run from the handler.",
          provider: "fake-harness",
        },
      },
    });
    const fixture = createFixture({
      terminal,
      harness,
      terminalIntentRunner,
      sessionIds: ["ses_runner_create"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "runner-create",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: false,
        },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "session.ensureAgentWorkspace",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        sessionId: "ses_runner_create",
        worktree: expect.objectContaining({
          id: "wt_web_runner_create",
        }),
      }),
    ]);
    expect(terminal.snapshot().launches).toEqual([]);
    fixture.sqlite.close();
  });

  it("submits session.fork launch work through the command composition runner", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const worktree = new FakeWorktreeProvider({ now });
    const fixture = createFixture({
      worktree,
      terminalIntentRunner,
      sessionIds: ["ses_runner_fork"],
    });
    await fixture.queue.dispatch({
      type: "worktree.create",
      payload: { projectId: "web", branch: "fork-source" },
    });
    await fixture.queue.drain();
    const source = fixture.core
      .getSnapshot()
      .rows.find((candidate) => candidate.branch === "fork-source");
    if (source === undefined) {
      throw new Error("fork source was not created");
    }

    const receipt = await fixture.queue.dispatch({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "runner-fork",
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "session.ensureAgentWorkspace",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        sessionId: "ses_runner_fork",
        worktree: expect.objectContaining({ branch: "runner-fork" }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("routes Pi session.create through observer command launch wiring", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      terminal,
      harness: createPiHarnessProvider({
        command: "pi-test",
        extensionPath: "/tmp/station/piExtension.js",
        configPath: "/tmp/station/config.toml",
        now: () => new Date(now),
      }),
      sessionIds: ["ses_web_feature"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature",
        harness: {
          provider: "pi",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: false,
        },
        initialPrompt: "Review the task.",
      },
    });
    await fixture.queue.drain();

    const launch = terminal.snapshot().launches[0];
    expect(launch?.launchPlan).toMatchObject({
      provider: "pi",
      command: "pi-test",
      args: ["--extension", "/tmp/station/piExtension.js", "Review the task."],
      cwd: "/tmp/station/web/feature",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_feature",
        STATION_WORKTREE_PATH: "/tmp/station/web/feature",
        STATION_HARNESS_PROVIDER: "pi",
        STATION_SESSION_ID: "ses_web_feature",
        STATION_TERMINAL_PROVIDER: "fake-terminal",
        STATION_TERMINAL_TARGET_ID: "term_fake",
        STATION_CONFIG_PATH: "/tmp/station/config.toml",
      },
      providerData: {
        interactive: true,
        extensionPath: "/tmp/station/piExtension.js",
        initialPromptProvided: true,
        configPathProvided: true,
        terminalProvider: "fake-terminal",
        terminalTargetId: "term_fake",
      },
    });
    expect(JSON.stringify(launch?.launchPlan.providerData)).not.toContain("Review the task.");
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    fixture.sqlite.close();
  });

  it("routes Cursor session.create through observer command launch wiring", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      terminal,
      harness: createCursorHarnessProvider({
        command: "agent-test",
        now: () => new Date(now),
      }),
      sessionIds: ["ses_web_feature"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature",
        harness: {
          provider: "cursor",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: false,
        },
        initialPrompt: "Review the task.",
      },
    });
    await fixture.queue.drain();

    const launch = terminal.snapshot().launches[0];
    expect(launch?.launchPlan).toMatchObject({
      provider: "cursor",
      command: "agent-test",
      args: ["--workspace", "/tmp/station/web/feature", "Review the task."],
      cwd: "/tmp/station/web/feature",
      mode: "interactive",
      env: {
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_feature",
        STATION_WORKTREE_PATH: "/tmp/station/web/feature",
        STATION_HARNESS_PROVIDER: "cursor",
        STATION_SESSION_ID: "ses_web_feature",
        STATION_TERMINAL_PROVIDER: "fake-terminal",
        STATION_TERMINAL_TARGET_ID: "term_fake",
      },
      providerData: {
        interactive: true,
        observation: "hooks",
        initialPromptProvided: true,
        terminalProvider: "fake-terminal",
        terminalTargetId: "term_fake",
      },
    });
    expect(JSON.stringify(launch?.launchPlan.providerData)).not.toContain("Review the task.");
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    fixture.sqlite.close();
  });

  it("creates a session in the background when terminal focus is false", async () => {
    const harness = new FakeHarnessProvider({
      now,
      runs: [
        createFakeHarnessRun({
          id: "run_web_feature",
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
          state: "idle",
          now,
        }),
      ],
    });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      terminal,
      harness,
      sessionIds: ["ses_web_feature"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "feature",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: false,
        },
      },
    });
    await fixture.queue.drain();

    expect(receipt).toMatchObject({ accepted: true, status: "accepted" });
    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(terminal.snapshot().focused).toEqual([]);
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      sessionId: "ses_web_feature",
      state: "idle",
    });
    fixture.sqlite.close();
  });

  it("keeps the session.create title stable when the provider branch changes before first reconcile", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const harness = new FakeHarnessProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        const created = worktree.snapshot().worktrees[0];
        if (created === undefined) {
          throw new Error("Expected session.create to create a worktree before launch.");
        }
        created.branch = "agent-created-branch";
        harness.addRun(
          createFakeHarnessRun({
            id: "run_web_seeded_create",
            projectId: "web",
            worktreeId: created.id,
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      harness,
      sessionIds: ["ses_seeded_create"],
    });

    await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "original-session-title",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
        },
        terminal: {
          provider: "fake-terminal",
          layout: "agent-build-shell",
          focus: false,
        },
      },
    });
    await fixture.queue.drain();

    expect(fixture.core.getSnapshot().rows).toEqual([
      expect.objectContaining({
        id: "wt_web_original_session_title",
        branch: "agent-created-branch",
        agent: expect.objectContaining({
          sessionId: "ses_seeded_create",
          state: "working",
        }),
      }),
    ]);
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_seeded_create",
        worktreeId: "wt_web_original_session_title",
        title: "original-session-title",
      }),
    ]);
    fixture.sqlite.close();
  });

  it("maps session.create provider failure to SafeError and diagnostic envelope", async () => {
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({
        now,
        failures: {
          createWorktree: {
            tag: "WorktreeProviderError",
            code: "FAKE_WORKTREE_CREATE_FAILED",
            message: "The fake worktree provider could not create the worktree.",
            provider: "fake-worktree",
          },
        },
      }),
      sessionIds: ["ses_failed"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "broken",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "WorktreeProviderError",
        code: "FAKE_WORKTREE_CREATE_FAILED",
        provider: "fake-worktree",
        commandId: receipt.commandId,
        traceId: receipt.traceId,
      },
    });
    expect(await fixture.persistence.listCommandErrors(receipt.commandId)).toEqual([
      expect.objectContaining({
        commandId: receipt.commandId,
        envelope: expect.objectContaining({
          code: "FAKE_WORKTREE_CREATE_FAILED",
          provider: "fake-worktree",
        }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("removes a created worktree when session.create cannot open a terminal", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        openWorkspace: {
          tag: "TerminalProviderError",
          code: "FAKE_TERMINAL_OPEN_FAILED",
          message: "The fake terminal provider could not open the workspace.",
          provider: "fake-terminal",
        },
      },
    });
    const fixture = createFixture({ worktree, terminal, sessionIds: ["ses_cleanup_open"] });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "cleanup-open",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FAKE_TERMINAL_OPEN_FAILED",
        provider: "fake-terminal",
      },
    });
    expect(worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup_open",
        force: true,
      },
    ]);
    expect(worktree.snapshot().worktrees).toEqual([]);
    fixture.sqlite.close();
  });

  it("closes the opened terminal and removes the worktree when harness build fails", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "FAKE_HARNESS_BUILD_FAILED",
          message: "The fake harness provider could not build a launch plan.",
          provider: "fake-harness",
        },
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      harness,
      sessionIds: ["ses_cleanup_build"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "cleanup-build",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FAKE_HARNESS_BUILD_FAILED",
        provider: "fake-harness",
      },
    });
    expect(terminal.snapshot().closed).toEqual(["term_fake"]);
    expect(worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup_build",
        force: true,
      },
    ]);
    fixture.sqlite.close();
  });

  it("cleans up pre-launch resources when terminal launch fails", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        launchProcess: {
          tag: "TerminalProviderError",
          code: "FAKE_TERMINAL_LAUNCH_FAILED",
          message: "The fake terminal provider could not launch the process.",
          provider: "fake-terminal",
        },
      },
    });
    const fixture = createFixture({ worktree, terminal, sessionIds: ["ses_cleanup_launch"] });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "cleanup-launch",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FAKE_TERMINAL_LAUNCH_FAILED",
        provider: "fake-terminal",
      },
    });
    expect(terminal.snapshot().closed).toEqual(["term_fake"]);
    expect(worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup_launch",
        force: true,
      },
    ]);
    expect(await fixture.persistence.listSessions()).toEqual([]);
    fixture.sqlite.close();
  });

  it("does not fail session.create when focus fails after launch", async () => {
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        focusTarget: {
          tag: "TerminalProviderError",
          code: "FAKE_TERMINAL_FOCUS_FAILED",
          message: "The fake terminal provider could not focus the target.",
          provider: "fake-terminal",
        },
      },
    });
    const harness = new FakeHarnessProvider({
      now,
      runs: [
        createFakeHarnessRun({
          id: "run_web_focus",
          projectId: "web",
          worktreeId: "wt_web_focus",
          sessionId: "ses_focus",
          state: "idle",
          now,
        }),
      ],
    });
    const fixture = createFixture({ terminal, harness, sessionIds: ["ses_focus"] });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "focus",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal", focus: true },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(terminal.snapshot().focused).toEqual([]);
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      sessionId: "ses_focus",
      state: "idle",
    });
    fixture.sqlite.close();
  });

  it("renames a session title without changing worktree identity", async () => {
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_feature",
            projectId: "web",
            branch: "feature",
            now,
          }),
        ],
      }),
      terminal: new FakeTerminalProvider({
        now,
        targets: [
          createFakeTerminalTarget({
            id: "term_web_feature",
            projectId: "web",
            worktreeId: "wt_web_feature",
            sessionId: "ses_web_feature",
            now,
          }),
        ],
      }),
      harness: new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_web_feature",
            projectId: "web",
            worktreeId: "wt_web_feature",
            sessionId: "ses_web_feature",
            state: "idle",
            now,
          }),
        ],
      }),
    });
    await fixture.core.reconcile("pre-rename");
    expect(fixture.core.getSnapshot().sessions[0]).toMatchObject({
      id: "ses_web_feature",
      title: "feature",
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.rename",
      payload: {
        sessionId: "ses_web_feature",
        title: "Readable feature task",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().sessions[0]).toMatchObject({
      id: "ses_web_feature",
      title: "Readable feature task",
    });
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      id: "wt_web_feature",
      branch: "feature",
    });
    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).map(
        (event) => event.type,
      ),
    ).toEqual(["command.accepted", "command.started", "session.updated", "command.succeeded"]);
    expect(await fixture.persistence.listEvents({ type: "session.updated" })).toEqual([
      expect.objectContaining({
        event: {
          type: "session.updated",
          sessionId: "ses_web_feature",
          patch: {
            title: "Readable feature task",
          },
        },
      }),
    ]);

    await fixture.core.reconcile("post-rename");
    expect(fixture.core.getSnapshot().sessions[0]?.title).toBe("Readable feature task");
    fixture.sqlite.close();
  });

  it("starts an agent on an existing no-agent worktree", async () => {
    const harness = new FakeHarnessProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        harness.addRun(
          createFakeHarnessRun({
            id: "run_web_existing",
            projectId: "web",
            worktreeId: "wt_web_existing",
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const fixture = createFixture({
      terminal,
      harness,
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_existing",
            projectId: "web",
            branch: "existing",
            now,
          }),
        ],
      }),
      sessionIds: ["ses_existing"],
    });
    await fixture.core.reconcile("pre-start-agent");

    await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_existing",
        harness: { provider: "fake-harness", mode: "interactive" },
        terminal: {
          provider: "fake-terminal",
          focus: true,
          origin: {
            provider: "tmux",
            clientId: "client_1",
          },
        },
      },
    });
    await fixture.queue.drain();

    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(terminal.snapshot().focused).toEqual(["term_fake"]);
    expect(terminal.snapshot().focusContexts).toEqual([
      { origin: { provider: "tmux", clientId: "client_1" } },
    ]);
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      sessionId: "ses_existing",
      state: "working",
    });
    fixture.sqlite.close();
  });

  it("submits session.startAgent launch work through the terminal intent runner seam", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        openWorkspace: {
          tag: "TerminalProviderError",
          code: "DIRECT_OPEN_SHOULD_NOT_RUN",
          message: "Direct terminal open should not run from the handler.",
          provider: "fake-terminal",
        },
      },
    });
    const harness = new FakeHarnessProvider({
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "DIRECT_BUILD_SHOULD_NOT_RUN",
          message: "Direct harness build should not run from the handler.",
          provider: "fake-harness",
        },
      },
    });
    const fixture = createFixture({
      terminal,
      harness,
      terminalIntentRunner,
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_runner_start",
            projectId: "web",
            branch: "runner-start",
            now,
          }),
        ],
      }),
      sessionIds: ["ses_runner_start"],
    });
    await fixture.core.reconcile("pre-start-agent-runner-seam");

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_runner_start",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "session.ensureAgentWorkspace",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        sessionId: "ses_runner_start",
        worktree: expect.objectContaining({
          id: "wt_web_runner_start",
        }),
      }),
    ]);
    expect(terminal.snapshot().launches).toEqual([]);
    fixture.sqlite.close();
  });

  it("rejects session.resumeAgent while the feature flag is disabled", async () => {
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_resume_disabled",
            projectId: "web",
            branch: "resume-disabled",
            now,
          }),
        ],
      }),
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.resumeAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_resume_disabled",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "SESSION_RESUME_DISABLED",
      },
    });
    fixture.sqlite.close();
  });

  it("resumes an exact persisted recovery handle through the terminal intent runner seam", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const fixture = createFixture({
      terminalIntentRunner,
      featureFlags: { sessionResumeAgent: true },
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_resume",
            projectId: "web",
            branch: "resume",
            now,
          }),
        ],
      }),
    });
    const handle = await fixture.persistence.upsertSessionRecoveryHandle({
      id: "report_resume",
      provider: "fake-harness",
      projectId: "web",
      worktreeId: "wt_web_resume",
      sessionId: "ses_previous",
      target: { kind: "native-session", id: "native_session_123" },
      cwd: "/tmp/station/web/resume",
      observedAt: now,
      lastSeenAt: now,
    });
    await fixture.core.reconcile("pre-resume");

    expect(fixture.core.getSnapshot().rows[0]?.recovery).toMatchObject({
      kind: "agent-resume",
      handleId: handle.id,
      provider: "fake-harness",
      targetKind: "native-session",
      sessionId: "ses_previous",
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.resumeAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_resume",
        recoveryHandleId: handle.id,
        terminal: { provider: "fake-terminal", focus: false },
        initialPrompt: "Continue the recovered context.",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "session.ensureAgentWorkspace",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        sessionId: "ses_previous",
        initialPrompt: "Continue the recovered context.",
        harness: {
          provider: "fake-harness",
          mode: "interactive",
        },
        resume: {
          target: { kind: "native-session", id: "native_session_123" },
          previousSessionId: "ses_previous",
          recoveryHandleId: handle.id,
        },
      }),
    ]);
    fixture.sqlite.close();
  });

  it("keeps the session.startAgent title stable when the provider branch changes before first reconcile", async () => {
    const worktree = new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_existing_title",
          projectId: "web",
          branch: "existing-session-title",
          now,
        }),
      ],
    });
    const harness = new FakeHarnessProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        const existing = worktree.snapshot().worktrees[0];
        if (existing === undefined) {
          throw new Error("Expected an existing worktree before launch.");
        }
        existing.branch = "agent-switched-branch";
        harness.addRun(
          createFakeHarnessRun({
            id: "run_web_seeded_start",
            projectId: "web",
            worktreeId: existing.id,
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      harness,
      sessionIds: ["ses_seeded_start"],
    });
    await fixture.core.reconcile("pre-start-agent-title");

    await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_existing_title",
        harness: { provider: "fake-harness", mode: "interactive" },
        terminal: {
          provider: "fake-terminal",
          focus: false,
        },
      },
    });
    await fixture.queue.drain();

    expect(fixture.core.getSnapshot().rows).toEqual([
      expect.objectContaining({
        id: "wt_web_existing_title",
        branch: "agent-switched-branch",
        agent: expect.objectContaining({
          sessionId: "ses_seeded_start",
          state: "working",
        }),
      }),
    ]);
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_seeded_start",
        worktreeId: "wt_web_existing_title",
        title: "existing-session-title",
      }),
    ]);
    fixture.sqlite.close();
  });

  it("starts an existing worktree with its most recently seen harness when no provider is requested", async () => {
    const rememberedHarness = new CapturingHarnessProvider({ id: "remembered-harness", now });
    const defaultHarness = new CapturingHarnessProvider({ id: "fake-harness", now });
    const existingWorktree = createFakeWorktree({
      id: "wt_web_remembered",
      projectId: "web",
      branch: "remembered",
      now,
    });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        rememberedHarness.addRun(
          createFakeHarnessRun({
            id: "run_web_remembered",
            provider: "remembered-harness",
            projectId: "web",
            worktreeId: "wt_web_remembered",
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const fixture = createFixture({
      terminal,
      harnesses: [defaultHarness, rememberedHarness],
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [existingWorktree],
      }),
      sessionIds: ["ses_remembered_next"],
    });
    await fixture.persistence.persistReconcileResult({
      projects: config.projects,
      worktrees: [existingWorktree],
      terminalTargets: [],
      harnessRuns: [
        createFakeHarnessRun({
          id: "run_web_default_previous",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: "wt_web_remembered",
          sessionId: "ses_default_previous",
          state: "exited",
          now: "2026-05-21T11:00:00.000Z",
        }),
        createFakeHarnessRun({
          id: "run_web_remembered_later",
          provider: "remembered-harness",
          projectId: "web",
          worktreeId: "wt_web_remembered",
          sessionId: "ses_remembered_later",
          state: "exited",
          now: "2026-05-21T11:30:00.000Z",
        }),
      ],
      observedAt: "2026-05-21T11:00:00.000Z",
    });
    await fixture.core.reconcile("pre-start-agent-remembered");

    await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_remembered",
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    expect(defaultHarness.lastBuildRequest).toBeUndefined();
    expect(rememberedHarness.lastBuildRequest).toMatchObject({
      sessionId: "ses_remembered_next",
      worktree: {
        id: "wt_web_remembered",
      },
    });
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      harness: "remembered-harness",
      sessionId: "ses_remembered_next",
      state: "working",
    });
    fixture.sqlite.close();
  });

  it("remembers the previous harness when the worktree id changes but the normalized path is stable", async () => {
    const rememberedHarness = new CapturingHarnessProvider({ id: "remembered-harness", now });
    const defaultHarness = new CapturingHarnessProvider({ id: "fake-harness", now });
    const previousWorktreePath = "/private/var/tmp/station/web/remembered/";
    const currentWorktreePath = "/var/tmp/station/web/remembered";
    const previousWorktree = createFakeWorktree({
      id: "wt_web_remembered_old",
      projectId: "web",
      branch: "remembered-old",
      path: previousWorktreePath,
      now: "2026-05-21T11:00:00.000Z",
    });
    const currentWorktree = createFakeWorktree({
      id: "wt_web_remembered_current",
      projectId: "web",
      branch: "remembered-current",
      path: currentWorktreePath,
      now,
    });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        rememberedHarness.addRun(
          createFakeHarnessRun({
            id: "run_web_remembered_current",
            provider: "remembered-harness",
            projectId: "web",
            worktreeId: "wt_web_remembered_current",
            sessionId: launchPlan.env?.STATION_SESSION_ID,
            state: "working",
            now,
          }),
        );
      },
    });
    const fixture = createFixture({
      terminal,
      harnesses: [defaultHarness, rememberedHarness],
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [currentWorktree],
      }),
      sessionIds: ["ses_remembered_current"],
    });
    await fixture.persistence.persistReconcileResult({
      projects: config.projects,
      worktrees: [previousWorktree],
      terminalTargets: [],
      harnessRuns: [
        createFakeHarnessRun({
          id: "run_web_remembered_old",
          provider: "remembered-harness",
          projectId: "web",
          worktreeId: "wt_web_remembered_old",
          sessionId: "ses_remembered_old",
          state: "exited",
          now: "2026-05-21T11:00:00.000Z",
        }),
      ],
      observedAt: "2026-05-21T11:00:00.000Z",
    });
    await fixture.core.reconcile("pre-start-agent-path-remembered");

    await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_remembered_current",
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    expect(defaultHarness.lastBuildRequest).toBeUndefined();
    expect(rememberedHarness.lastBuildRequest).toMatchObject({
      sessionId: "ses_remembered_current",
      worktree: {
        id: "wt_web_remembered_current",
        path: currentWorktreePath,
      },
    });
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({
      harness: "remembered-harness",
      sessionId: "ses_remembered_current",
      state: "working",
    });
    fixture.sqlite.close();
  });

  it("rejects session.startAgent when a primary agent already exists", async () => {
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({ id: "wt_web_busy", projectId: "web", branch: "busy", now }),
        ],
      }),
      terminal: new FakeTerminalProvider({ now }),
      harness: new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_web_busy",
            projectId: "web",
            worktreeId: "wt_web_busy",
            sessionId: "ses_web_busy",
            state: "working",
            now,
          }),
        ],
      }),
      sessionIds: ["ses_rejected"],
    });
    await fixture.core.reconcile("busy");

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_busy",
        harness: { provider: "fake-harness" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "SESSION_ALREADY_HAS_AGENT",
        worktreeId: "wt_web_busy",
        sessionId: "ses_web_busy",
      },
    });
    fixture.sqlite.close();
  });

  it("closes the terminal opened by session.startAgent when launch setup fails", async () => {
    const worktree = new FakeWorktreeProvider({
      now,
      worktrees: [
        createFakeWorktree({
          id: "wt_web_cleanup_start",
          projectId: "web",
          branch: "cleanup-start",
          now,
        }),
      ],
    });
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "FAKE_HARNESS_BUILD_FAILED",
          message: "The fake harness provider could not build a launch plan.",
          provider: "fake-harness",
        },
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      harness,
      sessionIds: ["ses_cleanup_start"],
    });
    await fixture.core.reconcile("pre-start-agent-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_cleanup_start",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FAKE_HARNESS_BUILD_FAILED",
        provider: "fake-harness",
      },
    });
    expect(terminal.snapshot().closed).toEqual(["term_fake"]);
    expect(worktree.snapshot().removed).toEqual([]);
    expect(await fixture.persistence.listSessions()).toEqual([]);
    fixture.sqlite.close();
  });

  it("preserves the original command error when cleanup also fails", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        closeTarget: {
          tag: "TerminalProviderError",
          code: "FAKE_TERMINAL_CLOSE_FAILED",
          message: "The fake terminal provider could not close the target.",
          provider: "fake-terminal",
        },
      },
    });
    const harness = new FakeHarnessProvider({
      now,
      failures: {
        buildLaunch: {
          tag: "HarnessProviderError",
          code: "FAKE_HARNESS_BUILD_FAILED",
          message: "The fake harness provider could not build a launch plan.",
          provider: "fake-harness",
        },
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      harness,
      sessionIds: ["ses_cleanup_failure"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "cleanup-failure",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "FAKE_HARNESS_BUILD_FAILED",
        provider: "fake-harness",
      },
    });
    expect(worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup_failure",
        force: true,
      },
    ]);
    fixture.sqlite.close();
  });

  it("serializes conflicting start-agent commands by worktree", async () => {
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const launchOrder: string[] = [];
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        launchOrder.push(launchPlan.env?.STATION_SESSION_ID ?? "missing");
        if (launchOrder.length === 1) {
          await firstBlocked;
        }
      },
    });
    const fixture = createFixture({
      terminal,
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({ id: "wt_web_serial", projectId: "web", branch: "serial", now }),
        ],
      }),
      sessionIds: ["ses_serial_1", "ses_serial_2"],
    });
    await fixture.core.reconcile("serial");

    const first = fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_serial",
        harness: { provider: "fake-harness" },
      },
    });
    const second = fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_serial",
        harness: { provider: "fake-harness" },
      },
    });
    await Promise.all([first, second]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(launchOrder).toEqual(["ses_serial_1"]);

    releaseFirst();
    await fixture.queue.drain();

    expect(launchOrder).toEqual(["ses_serial_1", "ses_serial_2"]);
    fixture.sqlite.close();
  });
});

function createFixture(
  options: {
    worktree?: FakeWorktreeProvider;
    terminal?: FakeTerminalProvider;
    harness?: HarnessProvider;
    harnesses?: HarnessProvider[];
    terminalIntentRunner?: TerminalIntentRunner;
    sessionIds?: string[];
    featureFlags?: { sessionResumeAgent?: boolean };
  } = {},
) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const providers = new ProviderRegistry({
    worktree: options.worktree ?? new FakeWorktreeProvider({ now }),
    terminal: options.terminal ?? new FakeTerminalProvider({ now }),
    harnesses: options.harnesses ?? [options.harness ?? new FakeHarnessProvider({ now })],
  });
  const featureFlags = createFeatureFlagEvaluator({
    overrides: {
      ...(options.featureFlags?.sessionResumeAgent === undefined
        ? {}
        : { sessionResumeAgent: options.featureFlags.sessionResumeAgent }),
    },
  });
  const core = createObserverCore({
    config,
    providers,
    persistence,
    sqlite,
    clock,
    featureFlags,
  });
  const sessionIds = [...(options.sessionIds ?? [])];
  registerObserverCommandHandlers({
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    featureFlags,
    eventBus,
    clock,
    ...(options.terminalIntentRunner === undefined
      ? {}
      : { terminalIntentRunner: options.terminalIntentRunner }),
    idFactory: {
      sessionId: () => sessionIds.shift() ?? "ses_fallback",
    },
  });
  return { sqlite, persistence, eventBus, queue, providers, core };
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: [
    {
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
    },
  ],
};

function observerIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let breadcrumb = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    errorId: () => `err_${++error}`,
    observationId: () => `obs_${++observation}`,
    breadcrumbId: () => `crumb_${++breadcrumb}`,
  };
}

class CapturingHarnessProvider extends FakeHarnessProvider {
  lastBuildRequest: BuildHarnessLaunchRequest | undefined;

  override async buildLaunch(request: BuildHarnessLaunchRequest): Promise<HarnessLaunchPlan> {
    this.lastBuildRequest = request;
    return super.buildLaunch(request);
  }
}

class CapturingTerminalIntentRunner implements TerminalIntentRunner {
  readonly intents: TerminalIntent[] = [];

  async submitIntent(intent: TerminalIntent): Promise<TerminalIntentReceipt> {
    this.intents.push(intent);
    return {
      status: "accepted",
      accepted: true,
      commandId: intent.commandId,
      type: intent.type,
      terminalProvider: intent.terminalProvider,
      timestamp: now,
    };
  }
}

describe("worktree.create command", () => {
  it("creates a worktree with no session, agent, or terminal launch", async () => {
    // Station's New Session uses worktree.create then hosts the agent itself, so
    // — unlike session.create — it must NOT mint a session or spawn a terminal.
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({ terminal });

    const receipt = await fixture.queue.dispatch({
      type: "worktree.create",
      payload: { projectId: "web", branch: "solo-create" },
    });
    await fixture.queue.drain();

    expect(receipt).toMatchObject({ accepted: true, status: "accepted" });

    const rows = fixture.core.getSnapshot().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ branch: "solo-create" });
    expect(rows[0]?.agent).toBeUndefined();
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    expect(terminal.snapshot().launches).toHaveLength(0);

    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).map(
        (event) => event.type,
      ),
    ).toEqual(["command.accepted", "command.started", "command.succeeded"]);
    fixture.sqlite.close();
  });
});

describe("worktree.fork command", () => {
  async function createSource(fixture: ReturnType<typeof createFixture>, branch: string) {
    await fixture.queue.dispatch({
      type: "worktree.create",
      payload: { projectId: "web", branch },
    });
    await fixture.queue.drain();
    const row = fixture.core.getSnapshot().rows.find((candidate) => candidate.branch === branch);
    if (row === undefined) {
      throw new Error(`source worktree ${branch} was not created`);
    }
    return row;
  }

  it("branches off the source and seeds its working tree, with no session or terminal", async () => {
    // The native fork mirrors New Session: seed a worktree, then Station hosts the
    // inherited harness itself — so this must NOT mint a session or launch a terminal.
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({ worktree, terminal });
    const source = await createSource(fixture, "feature");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.fork",
      payload: { projectId: "web", sourceWorktreeId: source.id, branch: "feature-fork" },
    });
    await fixture.queue.drain();

    expect(receipt).toMatchObject({ accepted: true, status: "accepted" });

    const rows = fixture.core.getSnapshot().rows;
    expect(rows.map((row) => row.branch).sort()).toEqual(["feature", "feature-fork"]);
    expect(rows.find((row) => row.branch === "feature-fork")?.agent).toBeUndefined();
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    expect(terminal.snapshot().launches).toHaveLength(0);

    // The fork create pins base to the source branch HEAD and seeds from the source path.
    const forkCreate = worktree.snapshot().created.find((req) => req.branch === "feature-fork");
    expect(forkCreate).toMatchObject({
      branch: "feature-fork",
      base: "feature",
      seedFrom: { path: source.path, worktreeId: source.id },
    });
    fixture.sqlite.close();
  });

  it("omits the seed when copyDirty is false", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const fixture = createFixture({ worktree });
    const source = await createSource(fixture, "feature");

    await fixture.queue.dispatch({
      type: "worktree.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "feature-fork",
        copyDirty: false,
      },
    });
    await fixture.queue.drain();

    const forkCreate = worktree.snapshot().created.find((req) => req.branch === "feature-fork");
    expect(forkCreate?.seedFrom).toBeUndefined();
    expect(forkCreate?.base).toBe("feature");
    fixture.sqlite.close();
  });

  it("fails when the source worktree is not in the snapshot", async () => {
    const fixture = createFixture({});
    const receipt = await fixture.queue.dispatch({
      type: "worktree.fork",
      payload: { projectId: "web", sourceWorktreeId: "wt_missing", branch: "feature-fork" },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKTREE_NOT_FOUND" },
    });
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });
});
