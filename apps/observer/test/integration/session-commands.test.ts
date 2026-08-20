import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  BuildHarnessLaunchRequest,
  HarnessLaunchPlan,
  HarnessProvider,
  ManagedTerminalLaunchProcessResult,
  ManagedTerminalLifecycle,
  ProviderHealth,
  SafeError,
  TerminalLaunchProcessRequest,
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
import { describe, expect, it, vi } from "vitest";
import { createFeatureFlagEvaluator } from "../../src/features/evaluator";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
} from "../../src/internal";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";

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
        title: "feature",
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

  it("publishes the first created-session snapshot with existing Group membership", async () => {
    const fixture = createFixture({
      sessionIds: ["ses_grouped_existing"],
      harness: new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_grouped_existing",
            projectId: "web",
            worktreeId: "wt_web_grouped_existing",
            sessionId: "ses_grouped_existing",
            state: "idle",
            now,
          }),
        ],
      }),
    });
    await fixture.persistence.createSessionGroup({
      id: "grp_existing",
      projectId: "web",
      name: "Existing",
      createdAt: now,
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "grouped-existing",
        group: { kind: "existing", groupId: "grp_existing" },
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({
        id: "grp_existing",
        sessionIds: ["ses_grouped_existing"],
        version: 2,
      }),
    ]);
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({ id: "ses_grouped_existing" }),
    ]);
    fixture.sqlite.close();
  });

  it("creates an inline root Group as part of the session seed", async () => {
    const fixture = createFixture({
      sessionIds: ["ses_grouped_inline"],
      sessionGroupIds: ["grp_inline"],
      harness: new FakeHarnessProvider({
        now,
        runs: [
          createFakeHarnessRun({
            id: "run_grouped_inline",
            projectId: "web",
            worktreeId: "wt_web_grouped_inline",
            sessionId: "ses_grouped_inline",
            state: "idle",
            now,
          }),
        ],
      }),
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "grouped-inline",
        group: { kind: "create", name: "Release" },
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().sessionGroups).toEqual([
      {
        id: "grp_inline",
        projectId: "web",
        name: "Release",
        sessionIds: ["ses_grouped_inline"],
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    fixture.sqlite.close();
  });

  it("fails closed when an existing placement is no longer a root Group", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const fixture = createFixture({ worktree, sessionIds: ["ses_nested_refused"] });
    await fixture.persistence.createSessionGroup({
      id: "grp_parent",
      projectId: "web",
      name: "Parent",
      createdAt: now,
    });
    await fixture.persistence.createSessionGroup({
      id: "grp_nested",
      projectId: "web",
      name: "Nested",
      parentGroupId: "grp_parent",
      createdAt: now,
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "nested-refused",
        group: { kind: "existing", groupId: "grp_nested" },
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_NOT_ROOT" },
    });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    expect(worktree.snapshot().worktrees).toEqual([]);
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

  it("routes session.create launch work directly through the selected providers", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({ now });
    const fixture = createFixture({
      terminal,
      harness,
      sessionIds: ["ses_runner_create"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "runner-create",
        title: "Hexagonal PT 12",
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
    expect(terminal.snapshot().launches).toEqual([
      expect.objectContaining({
        worktree: expect.objectContaining({ id: "wt_web_runner_create" }),
        terminalTarget: expect.objectContaining({ sessionId: "ses_runner_create" }),
      }),
    ]);
    expect(await fixture.persistence.listSessions()).toEqual([
      expect.objectContaining({
        id: "ses_runner_create",
        title: "Hexagonal PT 12",
        worktreeId: "wt_web_runner_create",
      }),
    ]);
    fixture.sqlite.close();
  });

  it("fails session.create with the original health error before owned mutation", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({ now });
    const error = unavailableHarnessError();
    const fixture = createFixture({
      worktree,
      terminal,
      harness: unavailableHarness(error),
      sessionIds: ["ses_should_not_exist"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "blocked-create",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error,
    });
    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).map(
        (event) => event.type,
      ),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    expect(worktree.snapshot()).toMatchObject({ worktrees: [], created: [], removed: [] });
    expect(terminal.snapshot()).toMatchObject({ targets: [], launches: [] });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual([]);
    fixture.sqlite.close();
  });

  it("routes session.fork launch work directly through the selected providers", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree,
      terminal,
      sessionIds: ["ses_runner_fork", "ses_runner_fork_fallback"],
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
    await fixture.persistence.seedSession({
      sessionId: "ses_fork_source",
      projectId: "web",
      worktreeId: source.id,
      initialTitle: "Fork source",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
      group: { kind: "create", groupId: "group_fork_source", name: "Fork source Group" },
    });
    await fixture.core.reconcile("group-fork-source");

    const receipt = await fixture.queue.dispatch({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "runner-fork",
        title: "Hexagonal PT 12 Fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_fork_source",
          groupId: "group_fork_source",
        },
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();
    const fallbackReceipt = await fixture.queue.dispatch({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "runner-fork-fallback",
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(fixture.persistence.getCommand(fallbackReceipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(terminal.snapshot().launches).toEqual([
      expect.objectContaining({
        worktree: expect.objectContaining({ branch: "runner-fork" }),
        terminalTarget: expect.objectContaining({ sessionId: "ses_runner_fork" }),
      }),
      expect.objectContaining({
        worktree: expect.objectContaining({ branch: "runner-fork-fallback" }),
        terminalTarget: expect.objectContaining({ sessionId: "ses_runner_fork_fallback" }),
      }),
    ]);
    expect(fixture.core.getSnapshot().sessionGroups).toContainEqual(
      expect.objectContaining({
        id: "group_fork_source",
        sessionIds: ["ses_fork_source", "ses_runner_fork"],
      }),
    );
    expect(
      fixture.core
        .getSnapshot()
        .sessionGroups.some((group) => group.sessionIds.includes("ses_runner_fork_fallback")),
    ).toBe(false);
    expect(await fixture.persistence.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_runner_fork",
          title: "Hexagonal PT 12 Fork",
          worktreeId: expect.stringContaining("runner_fork"),
        }),
        expect.objectContaining({
          id: "ses_runner_fork_fallback",
          title: "runner-fork-fallback",
          worktreeId: expect.stringContaining("runner_fork_fallback"),
        }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("fails session.fork before creating its owned worktree or title", async () => {
    const source = createFakeWorktree({
      id: "wt_web_fork_gate_source",
      projectId: "web",
      branch: "fork-gate-source",
      now,
    });
    const worktree = new FakeWorktreeProvider({ now, worktrees: [source] });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree,
      terminal,
      harness: unavailableHarness(),
      sessionIds: ["ses_should_not_exist"],
    });
    await fixture.core.reconcile("pre-fork-preflight");
    const titlesBefore = await fixture.persistence.listWorktreeDisplayTitles();

    const receipt = await fixture.queue.dispatch({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "blocked-fork",
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: unavailableHarnessError(),
    });
    expect(worktree.snapshot().worktrees).toEqual([source]);
    expect(worktree.snapshot().created).toEqual([]);
    expect(worktree.snapshot().removed).toEqual([]);
    expect(terminal.snapshot()).toMatchObject({ targets: [], launches: [] });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual(titlesBefore);
    fixture.sqlite.close();
  });

  it("removes only fork-owned membership when a grouped fork launch fails", async () => {
    const source = createFakeWorktree({
      id: "wt_web_fork_cleanup_source",
      projectId: "web",
      branch: "fork-cleanup-source",
      now,
    });
    const worktree = new FakeWorktreeProvider({ now, worktrees: [source] });
    const terminal = new FakeTerminalProvider({
      now,
      failures: {
        launchProcess: {
          tag: "TerminalProviderError",
          code: "FAKE_FORK_LAUNCH_FAILED",
          message: "The fork launch failed.",
          provider: "fake-terminal",
        },
      },
    });
    const fixture = createFixture({
      worktree,
      terminal,
      sessionIds: ["ses_failed_grouped_fork"],
    });
    await fixture.persistence.seedSession({
      sessionId: "ses_fork_cleanup_source",
      projectId: "web",
      worktreeId: source.id,
      initialTitle: "Fork cleanup source",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
      group: { kind: "create", groupId: "group_fork_cleanup", name: "Cleanup" },
    });
    await fixture.core.reconcile("fork-cleanup-source");

    const receipt = await fixture.queue.dispatch({
      type: "session.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "failed-grouped-fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_fork_cleanup_source",
          groupId: "group_fork_cleanup",
        },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "FAKE_FORK_LAUNCH_FAILED" },
    });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: "ses_fork_cleanup_source" }),
    ]);
    await expect(fixture.persistence.listSessionGroups()).resolves.toContainEqual(
      expect.objectContaining({
        id: "group_fork_cleanup",
        sessionIds: ["ses_fork_cleanup_source"],
      }),
    );
    expect(worktree.snapshot().worktrees).toEqual([source]);
    fixture.sqlite.close();
  });

  it("routes Pi session.create through observer command launch wiring", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const harness = createPiHarnessProvider({
      command: "pi-test",
      extensionPath: "/tmp/station/piExtension.js",
      configPath: "/tmp/station/config.toml",
      now: () => new Date(now),
    });
    vi.spyOn(harness, "health").mockResolvedValue(healthyHarnessHealth(harness));
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
    const harness = createCursorHarnessProvider({
      command: "agent-test",
      now: () => new Date(now),
    });
    vi.spyOn(harness, "health").mockResolvedValue(healthyHarnessHealth(harness));
    vi.spyOn(
      harness as HarnessProvider & {
        hooksStatus: NonNullable<HarnessProvider["hooksStatus"]>;
      },
      "hooksStatus",
    ).mockResolvedValue({
      provider: "cursor",
      requested: true,
      installed: true,
      missing: [],
      message: "Installed.",
    });
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

  it("keeps a custom session.create title independent when the provider branch changes", async () => {
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
        branch: "station-e91f2b",
        title: "Hexagonal PT 12",
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
        id: "wt_web_station_e91f2b",
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
        worktreeId: "wt_web_station_e91f2b",
        title: "Hexagonal PT 12",
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
    const fixture = createFixture({
      worktree,
      terminal,
      sessionIds: ["ses_cleanup_open"],
      sessionGroupIds: ["grp_cleanup_open"],
    });

    const receipt = await fixture.queue.dispatch({
      type: "session.create",
      payload: {
        projectId: "web",
        branch: "cleanup-open",
        group: { kind: "create", name: "Temporary" },
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
        expectedPath: "/tmp/station/web/cleanup-open",
        expectedBranch: "cleanup-open",
        expectedRegistrationIdentity: "fake-registration:web:cleanup-open:managed",
        force: true,
      },
    ]);
    expect(worktree.snapshot().worktrees).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual([]);
    await expect(fixture.persistence.listSessionGroups()).resolves.toEqual([]);
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
        expectedPath: "/tmp/station/web/cleanup-build",
        expectedBranch: "cleanup-build",
        expectedRegistrationIdentity: "fake-registration:web:cleanup-build:managed",
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
        expectedPath: "/tmp/station/web/cleanup-launch",
        expectedBranch: "cleanup-launch",
        expectedRegistrationIdentity: "fake-registration:web:cleanup-launch:managed",
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
    await fixture.persistence.seedSession({
      sessionId: "ses_web_feature",
      projectId: "web",
      worktreeId: "wt_web_feature",
      initialTitle: "feature",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
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
      title: "Readable feature task",
      branch: "feature",
      path: "/tmp/station/web/feature",
    });
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual([
      expect.objectContaining({
        projectId: "web",
        worktreeId: "wt_web_feature",
        title: "Readable feature task",
      }),
    ]);
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
    await fixture.persistence.seedSession({
      sessionId: "ses_previous_title",
      projectId: "web",
      worktreeId: "wt_web_existing",
      initialTitle: "existing",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
    });
    await fixture.persistence.renameSession({
      sessionId: "ses_previous_title",
      title: "Durable existing workspace",
      renamedAt: now,
    });
    await fixture.persistence.markSessionsEnded({
      subject: { kind: "session", sessionId: "ses_previous_title" },
      endedAt: now,
    });
    await fixture.core.reconcile("pre-start-agent-renamed");

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
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      title: "Durable existing workspace",
      branch: "existing",
      agent: {
        sessionId: "ses_existing",
        state: "working",
      },
    });
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_existing",
        title: "Durable existing workspace",
      }),
    ]);
    fixture.sqlite.close();
  });

  it("rejects session.startAgent when the provider only retains a missing worktree", async () => {
    const missing = createFakeWorktree({
      id: "wt_web_missing",
      projectId: "web",
      branch: "missing",
      now,
    });
    missing.state = "missing";
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({ now, worktrees: [missing] }),
      terminal,
    });
    await fixture.core.reconcile("missing-worktree");
    expect(fixture.core.getSnapshot().rows).toEqual([]);

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: missing.id,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_NOT_FOUND",
        worktreeId: missing.id,
      },
    });
    expect(terminal.snapshot().launches).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    fixture.sqlite.close();
  });

  it("rejects session.startAgent when a foreign worktree is absent from the current snapshot", async () => {
    const foreign = createFakeWorktree({
      id: "wt_api_foreign",
      projectId: "api",
      branch: "foreign",
      now,
    });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree: new FakeWorktreeProvider({ now, worktrees: [foreign] }),
      terminal,
    });
    await fixture.core.reconcile("foreign-worktree");
    expect(fixture.core.getSnapshot().rows).toEqual([]);

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: foreign.id,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_NOT_FOUND",
        projectId: "web",
        worktreeId: foreign.id,
      },
    });
    expect(terminal.snapshot().launches).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    fixture.sqlite.close();
  });

  it("routes session.startAgent launch work directly through the selected providers", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const harness = new FakeHarnessProvider({ now });
    const fixture = createFixture({
      terminal,
      harness,
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
    expect(terminal.snapshot().launches).toEqual([
      expect.objectContaining({
        worktree: expect.objectContaining({
          id: "wt_web_runner_start",
        }),
        terminalTarget: expect.objectContaining({ sessionId: "ses_runner_start" }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("fails session.startAgent before title, session, or terminal mutation", async () => {
    const existing = createFakeWorktree({
      id: "wt_web_start_gate",
      projectId: "web",
      branch: "start-gate",
      now,
    });
    const worktree = new FakeWorktreeProvider({ now, worktrees: [existing] });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree,
      terminal,
      harness: unavailableHarness(),
      sessionIds: ["ses_should_not_exist"],
    });
    await fixture.core.reconcile("pre-start-preflight");
    const titlesBefore = await fixture.persistence.listWorktreeDisplayTitles();

    const receipt = await fixture.queue.dispatch({
      type: "session.startAgent",
      payload: {
        projectId: "web",
        worktreeId: existing.id,
        harness: { provider: "fake-harness" },
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: unavailableHarnessError(),
    });
    expect(worktree.snapshot()).toMatchObject({ worktrees: [existing], created: [], removed: [] });
    expect(terminal.snapshot()).toMatchObject({ targets: [], launches: [] });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual(titlesBefore);
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

  it("imports one recovery handle only when persistent managed launch is available", async () => {
    const worktree = createFakeWorktree({
      id: "wt_web_import_recovery",
      projectId: "web",
      branch: "import-recovery",
      now,
    });
    const fixture = createFixture({
      featureFlags: { sessionResumeAgent: true },
      managedTerminal: persistentManagedTerminal(),
      worktree: new FakeWorktreeProvider({ now, worktrees: [worktree] }),
    });
    await fixture.core.reconcile("pre-import-recovery");

    const receipt = await fixture.queue.dispatch({
      type: "session.importRecoveryHandle",
      payload: {
        projectId: "web",
        worktreeId: worktree.id,
        expectedPath: worktree.path,
        title: "Imported recovery title",
        handle: {
          id: "rec_import_recovery",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: worktree.id,
          sessionId: "ses_import_recovery",
          target: { kind: "native-session", id: "native_import_recovery" },
          cwd: worktree.path,
          observedAt: now,
          lastSeenAt: now,
        },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().rows).toEqual([
      expect.objectContaining({
        id: worktree.id,
        title: "Imported recovery title",
        branch: worktree.branch,
        path: worktree.path,
      }),
    ]);
    expect(fixture.core.getSnapshot().rows[0]).not.toHaveProperty("agent");
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    const conflict = await fixture.queue.dispatch({
      type: "session.importRecoveryHandle",
      payload: {
        projectId: "web",
        worktreeId: worktree.id,
        expectedPath: worktree.path,
        handle: {
          id: "rec_import_conflict",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: worktree.id,
          sessionId: "ses_other_owner",
          target: { kind: "native-session", id: "native_import_recovery" },
          cwd: worktree.path,
          observedAt: now,
          lastSeenAt: now,
        },
      },
    });
    await fixture.queue.drain();
    await expect(fixture.persistence.getCommand(conflict.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "SESSION_RECOVERY_IDENTITY_CONFLICT" },
    });
    await expect(
      fixture.persistence.listSessionRecoveryHandles({ worktreeId: worktree.id }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "fake-harness",
        sessionId: "ses_import_recovery",
        target: { kind: "native-session", id: "native_import_recovery" },
      }),
    ]);
    fixture.sqlite.close();
  });

  it("rejects recovery import without persistent managed launch", async () => {
    const worktree = createFakeWorktree({
      id: "wt_web_import_unmanaged",
      projectId: "web",
      branch: "import-unmanaged",
      now,
    });
    const fixture = createFixture({
      featureFlags: { sessionResumeAgent: true },
      worktree: new FakeWorktreeProvider({ now, worktrees: [worktree] }),
    });
    await fixture.core.reconcile("pre-import-unmanaged");

    const receipt = await fixture.queue.dispatch({
      type: "session.importRecoveryHandle",
      payload: {
        projectId: "web",
        worktreeId: worktree.id,
        expectedPath: worktree.path,
        handle: {
          id: "rec_import_unmanaged",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: worktree.id,
          sessionId: "ses_import_unmanaged",
          target: { kind: "native-session", id: "native_import_unmanaged" },
          cwd: worktree.path,
          observedAt: now,
          lastSeenAt: now,
        },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "SESSION_RECOVERY_PERSISTENT_TERMINAL_REQUIRED" },
    });
    await expect(fixture.persistence.listSessionRecoveryHandles()).resolves.toEqual([]);
    fixture.sqlite.close();
  });

  it("resumes an exact persisted recovery handle through the selected providers", async () => {
    const terminal = new FakeTerminalProvider({ now });
    const harness = new CapturingHarnessProvider({ now });
    const fixture = createFixture({
      terminal,
      harness,
      featureFlags: { sessionResumeAgent: true },
      managedTerminal: persistentManagedTerminal(),
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
    await fixture.persistence.persistReconcileResult({
      worktrees: [
        createFakeWorktree({
          id: "wt_web_resume",
          projectId: "web",
          branch: "resume",
          now,
        }),
      ],
      terminalTargets: [],
      harnessRuns: [
        createFakeHarnessRun({
          id: "run_previous",
          projectId: "web",
          worktreeId: "wt_web_resume",
          sessionId: "ses_previous",
          state: "idle",
          now,
        }),
      ],
      observedAt: now,
    });
    await fixture.persistence.markSessionsEnded({
      subject: { kind: "session", sessionId: "ses_previous" },
      endedAt: now,
    });
    await fixture.core.reconcile("pre-import-resume");
    const importReceipt = await fixture.queue.dispatch({
      type: "session.importRecoveryHandle",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_resume",
        expectedPath: "/tmp/station/web/resume",
        title: "Recovered custom title",
        handle: {
          id: "report_resume",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: "wt_web_resume",
          sessionId: "ses_previous",
          target: { kind: "native-session", id: "native_session_123" },
          cwd: "/tmp/station/web/resume",
          observedAt: now,
          lastSeenAt: now,
        },
      },
    });
    await fixture.queue.drain();
    await expect(fixture.persistence.getCommand(importReceipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    const [handle] = await fixture.persistence.listSessionRecoveryHandles({
      worktreeId: "wt_web_resume",
    });
    if (handle === undefined) throw new Error("Expected imported recovery handle.");

    expect(fixture.core.getSnapshot().rows[0]?.recovery).toMatchObject({
      kind: "agent-resume",
      handleId: handle.id,
      provider: "fake-harness",
      targetKind: "native-session",
      sessionId: "ses_previous",
    });
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      id: "wt_web_resume",
      title: "Recovered custom title",
      branch: "resume",
      path: "/tmp/station/web/resume",
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
    expect(terminal.snapshot().launches).toHaveLength(1);
    expect(harness.lastBuildRequest).toMatchObject({
      sessionId: "ses_previous",
      initialPrompt: "Continue the recovered context.",
      mode: "interactive",
      resume: {
        target: { kind: "native-session", id: "native_session_123" },
        previousSessionId: "ses_previous",
        recoveryHandleId: handle.id,
      },
    });
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "ses_previous", lifecycle: "open" })]),
    );
    expect(
      (await fixture.persistence.listSessions()).find((session) => session.id === "ses_previous"),
    ).not.toHaveProperty("endedAt");
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_previous",
        title: "Recovered custom title",
        origin: "station",
      }),
    ]);
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      title: "Recovered custom title",
      branch: "resume",
      path: "/tmp/station/web/resume",
    });
    fixture.sqlite.close();
  });

  it("fails session.resumeAgent before reopening or terminal mutation", async () => {
    const existing = createFakeWorktree({
      id: "wt_web_resume_gate",
      projectId: "web",
      branch: "resume-gate",
      now,
    });
    const worktree = new FakeWorktreeProvider({ now, worktrees: [existing] });
    const terminal = new FakeTerminalProvider({ now });
    const fixture = createFixture({
      worktree,
      terminal,
      harness: unavailableHarness(),
      featureFlags: { sessionResumeAgent: true },
      managedTerminal: persistentManagedTerminal(),
      sessionIds: ["ses_should_not_exist"],
    });
    await fixture.core.reconcile("pre-import-resume-gate");
    const importReceipt = await fixture.queue.dispatch({
      type: "session.importRecoveryHandle",
      payload: {
        projectId: "web",
        worktreeId: existing.id,
        expectedPath: existing.path,
        title: "Retryable recovered title",
        handle: {
          id: "report_resume_gate",
          provider: "fake-harness",
          projectId: "web",
          worktreeId: existing.id,
          sessionId: "ses_resume_gate",
          target: { kind: "native-session", id: "native_resume_gate" },
          cwd: existing.path,
          observedAt: now,
          lastSeenAt: now,
        },
      },
    });
    await fixture.queue.drain();
    await expect(fixture.persistence.getCommand(importReceipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    const [handle] = await fixture.persistence.listSessionRecoveryHandles({
      worktreeId: existing.id,
    });
    if (handle === undefined) throw new Error("Expected imported recovery handle.");
    const titlesBefore = await fixture.persistence.listWorktreeDisplayTitles();

    const receipt = await fixture.queue.dispatch({
      type: "session.resumeAgent",
      payload: {
        projectId: "web",
        worktreeId: existing.id,
        recoveryHandleId: handle.id,
        terminal: { provider: "fake-terminal" },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: unavailableHarnessError(),
    });
    expect(worktree.snapshot()).toMatchObject({ worktrees: [existing], created: [], removed: [] });
    expect(terminal.snapshot()).toMatchObject({ targets: [], launches: [] });
    await expect(fixture.persistence.listSessions()).resolves.toEqual([]);
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual(titlesBefore);
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      title: "Retryable recovered title",
      branch: existing.branch,
      path: existing.path,
      recovery: {
        handleId: handle.id,
        provider: "fake-harness",
        targetKind: "native-session",
      },
    });
    await expect(
      fixture.persistence.listSessionRecoveryHandles({ worktreeId: existing.id }),
    ).resolves.toEqual([handle]);
    fixture.sqlite.close();
  });

  it("mints a fresh resume identity while preserving the canonical worktree title", async () => {
    const harness = new FakeHarnessProvider({ now });
    const terminal = new FakeTerminalProvider({
      now,
      onLaunch: async ({ launchPlan }) => {
        harness.addRun(
          createFakeHarnessRun({
            id: "run_resume_fresh",
            projectId: "web",
            worktreeId: "wt_web_resume_fresh",
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
      featureFlags: { sessionResumeAgent: true },
      sessionIds: ["ses_resume_fresh"],
      worktree: new FakeWorktreeProvider({
        now,
        worktrees: [
          createFakeWorktree({
            id: "wt_web_resume_fresh",
            projectId: "web",
            branch: "resume-fresh",
            now,
          }),
        ],
      }),
    });
    await fixture.core.reconcile("pre-resume-fresh");
    await fixture.persistence.seedSession({
      sessionId: "ses_resume_history",
      projectId: "web",
      worktreeId: "wt_web_resume_fresh",
      initialTitle: "resume-fresh",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
    });
    await fixture.persistence.renameSession({
      sessionId: "ses_resume_history",
      title: "Durable resumed workspace",
      renamedAt: now,
    });
    await fixture.persistence.markSessionsEnded({
      subject: { kind: "session", sessionId: "ses_resume_history" },
      endedAt: now,
    });
    const handle = await fixture.persistence.upsertSessionRecoveryHandle({
      id: "report_resume_fresh",
      provider: "fake-harness",
      projectId: "web",
      worktreeId: "wt_web_resume_fresh",
      target: { kind: "native-session", id: "native_resume_fresh" },
      cwd: "/tmp/station/web/resume-fresh",
      observedAt: now,
      lastSeenAt: now,
    });
    await fixture.core.reconcile("pre-resume-fresh-command");

    const receipt = await fixture.queue.dispatch({
      type: "session.resumeAgent",
      payload: {
        projectId: "web",
        worktreeId: "wt_web_resume_fresh",
        recoveryHandleId: handle.id,
        terminal: { provider: "fake-terminal", focus: false },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().rows[0]).toMatchObject({
      title: "Durable resumed workspace",
      branch: "resume-fresh",
      agent: { sessionId: "ses_resume_fresh", state: "working" },
    });
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: "ses_resume_fresh",
        title: "Durable resumed workspace",
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
    await fixture.persistence.seedSession({
      sessionId: "ses_default_previous",
      projectId: "web",
      worktreeId: existingWorktree.id,
      initialTitle: existingWorktree.branch,
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: "2026-05-21T11:00:00.000Z",
      lastSeenAt: "2026-05-21T11:00:00.000Z",
    });
    await fixture.persistence.seedSession({
      sessionId: "ses_remembered_later",
      projectId: "web",
      worktreeId: existingWorktree.id,
      initialTitle: existingWorktree.branch,
      harness: "remembered-harness",
      terminalProvider: "fake-terminal",
      createdAt: "2026-05-21T11:30:00.000Z",
      lastSeenAt: "2026-05-21T11:30:00.000Z",
    });
    await fixture.persistence.persistReconcileResult({
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
    await fixture.persistence.seedSession({
      sessionId: "ses_remembered_old",
      projectId: "web",
      worktreeId: previousWorktree.id,
      initialTitle: previousWorktree.branch,
      harness: "remembered-harness",
      terminalProvider: "fake-terminal",
      createdAt: "2026-05-21T11:00:00.000Z",
      lastSeenAt: "2026-05-21T11:00:00.000Z",
    });
    await fixture.persistence.persistReconcileResult({
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
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual([
      expect.objectContaining({
        projectId: "web",
        worktreeId: "wt_web_cleanup_start",
        title: "cleanup-start",
      }),
    ]);
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
        expectedPath: "/tmp/station/web/cleanup-failure",
        expectedBranch: "cleanup-failure",
        expectedRegistrationIdentity: "fake-registration:web:cleanup-failure:managed",
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
    managedTerminal?: ManagedTerminalLifecycle;
    sessionIds?: string[];
    sessionGroupIds?: string[];
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
    ...(options.managedTerminal === undefined ? {} : { managedTerminal: options.managedTerminal }),
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
    clock,
    featureFlags,
  });
  const sessionIds = [...(options.sessionIds ?? [])];
  const sessionGroupIds = [...(options.sessionGroupIds ?? [])];
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    featureFlags,
    eventBus,
    clock,
    idFactory: {
      sessionId: () => sessionIds.shift() ?? "ses_fallback",
      sessionGroupId: () => sessionGroupIds.shift() ?? "grp_fallback",
    },
  });
  return { sqlite, persistence, eventBus, queue, providers, core };
}

function persistentManagedTerminal(): ManagedTerminalLifecycle {
  const terminal = new FakeTerminalProvider({ now });
  let binding = 0;
  const launchProcess = async (
    request: TerminalLaunchProcessRequest,
  ): Promise<ManagedTerminalLaunchProcessResult> => {
    await terminal.launchProcess(request);
    return {
      terminalTargetId: request.terminalTarget.targetId,
      agentEndpointId: request.agentEndpointId,
      started: true,
      attachment: {
        kind: "managed-terminal",
        terminalTargetId: request.terminalTarget.targetId,
      },
    };
  };
  return {
    id: "native",
    capabilities: () => terminal.capabilities(),
    health: () => terminal.health(),
    listTargets: () => terminal.listTargets(),
    openWorkspace: (request) => terminal.openWorkspace(request),
    openManagedWorkspace: async (request) => ({
      ...(await terminal.openWorkspace(request)),
      bindingToken: `binding_${++binding}`,
    }),
    launchProcess,
    launchManagedProcess: launchProcess,
    focusTarget: (targetId, context) => terminal.focusTarget(targetId, context),
    closeTarget: (targetId) => terminal.closeTarget(targetId),
    captureTarget: (targetId) => terminal.captureTarget(targetId),
    sendInput: (targetId, input) => terminal.sendInput(targetId, input),
    attachmentForTarget: async () => undefined,
    releaseTarget: async () => true,
  };
}

const config: StationConfig = {
  schemaVersion: 1,
  workspace: DEFAULT_WORKSPACE_CONFIG,
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

function unavailableHarnessError(): SafeError {
  return {
    tag: "ProviderUnavailableError",
    code: "FAKE_CLI_MISSING",
    message: "The selected harness CLI is unavailable.",
    provider: "fake-harness",
  };
}

function unavailableHarness(error: SafeError = unavailableHarnessError()): FakeHarnessProvider {
  return new FakeHarnessProvider({
    now,
    health: { status: "unavailable", lastError: error },
  });
}

function healthyHarnessHealth(harness: HarnessProvider): ProviderHealth {
  return {
    providerId: harness.id,
    providerType: "harness",
    status: "healthy",
    lastCheckedAt: now,
    capabilities: harness.capabilities(),
  };
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

  it("preflights launch-bound creates before worktree mutation", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const fixture = createFixture({ worktree, harness: unavailableHarness() });

    const receipt = await fixture.queue.dispatch({
      type: "worktree.create",
      payload: {
        projectId: "web",
        branch: "blocked-native-create",
        launchHarness: "fake-harness",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: unavailableHarnessError(),
    });
    expect(worktree.snapshot()).toMatchObject({ worktrees: [], created: [], removed: [] });
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

  it("validates source Group intent without minting native fork membership", async () => {
    const worktree = new FakeWorktreeProvider({ now });
    const fixture = createFixture({ worktree });
    const source = await createSource(fixture, "grouped-feature");
    await fixture.persistence.seedSession({
      sessionId: "ses_native_fork_source",
      projectId: "web",
      worktreeId: source.id,
      initialTitle: "Native fork source",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: now,
      lastSeenAt: now,
      group: { kind: "create", groupId: "group_native_fork", name: "Native fork" },
    });
    await fixture.core.reconcile("native-fork-source-group");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "grouped-feature-fork",
        group: {
          kind: "source",
          sourceSessionId: "ses_native_fork_source",
          groupId: "group_native_fork",
        },
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({ id: "ses_native_fork_source" }),
    ]);
    expect(fixture.core.getSnapshot().sessionGroups).toContainEqual(
      expect.objectContaining({
        id: "group_native_fork",
        sessionIds: ["ses_native_fork_source"],
      }),
    );
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

  it("preflights launch-bound forks before creating a second worktree", async () => {
    const source = createFakeWorktree({
      id: "wt_web_native_fork_source",
      projectId: "web",
      branch: "native-fork-source",
      now,
    });
    const worktree = new FakeWorktreeProvider({ now, worktrees: [source] });
    const fixture = createFixture({ worktree, harness: unavailableHarness() });
    await fixture.core.reconcile("pre-native-fork-preflight");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.fork",
      payload: {
        projectId: "web",
        sourceWorktreeId: source.id,
        branch: "blocked-native-fork",
        launchHarness: "fake-harness",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: unavailableHarnessError(),
    });
    expect(worktree.snapshot().worktrees).toEqual([source]);
    expect(worktree.snapshot().created).toEqual([]);
    expect(worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });
});
