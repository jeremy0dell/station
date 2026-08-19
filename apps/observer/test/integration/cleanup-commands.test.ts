import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type { HarnessProvider } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
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

describe("cleanup command handlers", () => {
  it("closes an active harness only after force and leaves the terminal open", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "session.close",
      payload: {
        sessionId: "ses_web_cleanup",
        mode: "harness",
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.core.getSnapshot().rows[0]?.agent).toMatchObject({ state: "exited" });
    expect(fixture.core.getSnapshot().sessions).toEqual([
      expect.objectContaining({ id: "ses_web_cleanup", origin: "station" }),
    ]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "open" }),
      ]),
    );
    await expect(
      fixture.persistence.listEvents({ commandId: receipt.commandId }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session.removed" })]),
    );
    fixture.sqlite.close();
  });

  it("errors honestly on force close-harness when the provider cannot stop runs", async () => {
    const fixture = await createFixture({ state: "working", harnessStopSupported: false });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "session.close",
      payload: {
        sessionId: "ses_web_cleanup",
        mode: "harness",
        force: true,
      },
    });
    await fixture.queue.drain();

    // A hollow "success" would leave the still-running agent in place and the
    // row reappearing each reconcile; mode:harness has no terminal-close
    // fallback, so the command must fail rather than pretend to have stopped it.
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "HARNESS_STOP_UNSUPPORTED" },
    });
    fixture.sqlite.close();
  });

  it("rejects terminal close for an active agent without force", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "terminal.close",
      payload: {
        worktreeId: "wt_web_cleanup",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "TERMINAL_CLOSE_AGENT_ACTIVE_REQUIRES_FORCE",
        worktreeId: "wt_web_cleanup",
        sessionId: "ses_web_cleanup",
      },
    });
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    fixture.sqlite.close();
  });

  it("closes a forced terminal target and records session removal evidence", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "terminal.close",
      payload: {
        worktreeId: "wt_web_cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(await fixture.persistence.listEvents({ commandId: receipt.commandId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.removed",
          event: { type: "session.removed", sessionId: "ses_web_cleanup" },
        }),
      ]),
    );
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_web_cleanup",
          lifecycle: "ended",
          endedAt: now,
        }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("ends a retained Station session when terminal.close targets its worktree", async () => {
    const fixture = await createFixture({ state: "terminal" });
    await fixture.persistence.persistReconcileResult({
      worktrees: [fixture.worktreeObservation],
      terminalTargets: [],
      harnessRuns: [
        createFakeHarnessRun({
          id: "run_web_cleanup_previous",
          projectId: "web",
          worktreeId: "wt_web_cleanup",
          sessionId: "ses_web_cleanup",
          state: "idle",
          now,
        }),
      ],
      observedAt: now,
    });
    await fixture.core.reconcile("pre-retained-terminal-close");
    expect(fixture.core.getSnapshot().rows[0]?.agent).toBeUndefined();
    expect(fixture.core.getSnapshot().sessions[0]).toMatchObject({
      id: "ses_web_cleanup",
      origin: "station",
      terminal: expect.objectContaining({ closeable: true }),
    });

    const receipt = await fixture.queue.dispatch({
      type: "terminal.close",
      payload: { worktreeId: "wt_web_cleanup" },
    });
    await fixture.queue.drain();

    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.removed",
          event: { type: "session.removed", sessionId: "ses_web_cleanup" },
        }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("routes terminal focus and close directly through the registered provider", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const focusReceipt = await fixture.queue.dispatch({
      type: "terminal.focus",
      payload: { worktreeId: "wt_web_cleanup" },
    });
    await fixture.queue.drain();
    const closeReceipt = await fixture.queue.dispatch({
      type: "terminal.close",
      payload: { worktreeId: "wt_web_cleanup", force: true },
    });
    await fixture.queue.drain();

    expect(focusReceipt.commandId).not.toBe(closeReceipt.commandId);
    expect(fixture.terminal.snapshot().focused).toEqual(["term_web_cleanup"]);
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended", endedAt: now }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("ends Station membership after session.close all succeeds", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-session-close-all");

    const receipt = await fixture.queue.dispatch({
      type: "session.close",
      payload: { sessionId: "ses_web_cleanup", mode: "all", force: true },
    });
    await fixture.queue.drain();

    expect(fixture.harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended", endedAt: now }),
      ]),
    );
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session.removed" })]),
    );
    fixture.sqlite.close();
  });

  it("routes session terminal cleanup directly through the registered provider", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "session.close",
      payload: { sessionId: "ses_web_cleanup", mode: "terminal", force: true },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    fixture.sqlite.close();
  });

  it("rejects dirty worktree removal without force", async () => {
    const fixture = await createFixture({ dirty: true, state: "none" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_DIRTY_REQUIRES_FORCE",
        worktreeId: "wt_web_cleanup",
      },
    });
    expect(fixture.worktree.snapshot().worktrees).toHaveLength(1);
    fixture.sqlite.close();
  });

  it("rejects project root removal before calling the worktree provider", async () => {
    const fixture = await createFixture({ state: "none", projectRootPath: true });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED",
        worktreeId: "wt_web_cleanup",
      },
    });
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });

  it("refuses a stale feature selection that now owns the default branch before cleanup", async () => {
    const fixture = await createFixture({ state: "working" });
    await fixture.core.reconcile("pre-cleanup");
    fixture.worktreeObservation.branch = "main";

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: fixture.worktreeObservation.path,
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: {
        tag: "CommandValidationError",
        code: "WORKTREE_REMOVE_STALE_SELECTION",
        worktreeId: "wt_web_cleanup",
      },
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });

  it("refuses unreserved removal while a Station renderer owns the active terminal", async () => {
    const fixture = await createFixture({ state: "working", terminalCloseable: false });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "EXTERNAL_TERMINAL_EXIT_REQUIRED" },
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });

  it("force-removes an active worktree after stopping harness and closing terminal", async () => {
    const fixture = await createFixture({ dirty: true, state: "working" });
    await fixture.persistence.seedSession({
      sessionId: "ses_web_cleanup_older",
      projectId: "web",
      worktreeId: "wt_web_cleanup",
      initialTitle: "older cleanup session",
      harness: "fake-harness",
      terminalProvider: "fake-terminal",
      createdAt: "2026-05-21T11:00:00.000Z",
      lastSeenAt: "2026-05-21T11:00:00.000Z",
    });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    ]);
    expect(await fixture.persistence.listEvents({ commandId: receipt.commandId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.removed",
          event: { type: "session.removed", sessionId: "ses_web_cleanup" },
        }),
        expect.objectContaining({
          type: "worktree.removed",
          event: { type: "worktree.removed", worktreeId: "wt_web_cleanup" },
        }),
      ]),
    );
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    expect(
      (await fixture.persistence.listSessions())
        .filter((session) => session.worktreeId === "wt_web_cleanup")
        .map((session) => ({ id: session.id, lifecycle: session.lifecycle })),
    ).toEqual([
      { id: "ses_web_cleanup", lifecycle: "ended" },
      { id: "ses_web_cleanup_older", lifecycle: "ended" },
    ]);
    expect(
      (await fixture.persistence.listWorktreeDisplayTitles()).some(
        (title) => title.projectId === "web" && title.worktreeId === "wt_web_cleanup",
      ),
    ).toBe(false);
    fixture.sqlite.close();
  });

  it("routes worktree terminal cleanup directly through the registered provider", async () => {
    const fixture = await createFixture({ dirty: true, state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    ]);
    fixture.sqlite.close();
  });

  it("removes a clean exited worktree when terminal cleanup finds an already-missing target", async () => {
    const fixture = await createFixture({
      state: "exited",
      terminalCloseTargetMissing: true,
    });
    await fixture.core.reconcile("pre-cleanup");

    expect(fixture.core.getSnapshot().rows[0]?.agent?.state).toBe("exited");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
      },
    ]);
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ses_web_cleanup",
          lifecycle: "ended",
          endedAt: now,
        }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("force-removes a worktree when terminal cleanup finds an already-missing target", async () => {
    const fixture = await createFixture({
      dirty: true,
      state: "working",
      terminalCloseTargetMissing: true,
    });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    ]);
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });

  it("force-removes an active worktree when the terminal-owned harness cannot stop natively", async () => {
    const fixture = await createFixture({
      dirty: true,
      state: "working",
      harnessStopSupported: false,
      terminalCloseable: true,
    });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    ]);
    fixture.sqlite.close();
  });

  it("refuses active worktree removal before probing a renderer-owned terminal", async () => {
    const fixture = await createFixture({
      dirty: true,
      state: "working",
      harnessStopSupported: false,
      terminalCloseable: false,
    });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "EXTERNAL_TERMINAL_EXIT_REQUIRED" },
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });
});

async function createFixture(input: {
  dirty?: boolean;
  state: "none" | "terminal" | "working" | "exited";
  harnessStopSupported?: boolean;
  terminalCloseable?: boolean;
  terminalCloseTargetMissing?: boolean;
  projectRootPath?: boolean;
}) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  await persistence.seedSession({
    sessionId: "ses_web_cleanup",
    projectId: "web",
    worktreeId: "wt_web_cleanup",
    initialTitle: "cleanup",
    harness: "fake-harness",
    terminalProvider: "fake-terminal",
    createdAt: now,
    lastSeenAt: now,
  });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const worktreeObservation = createFakeWorktree({
    id: "wt_web_cleanup",
    projectId: "web",
    branch: "cleanup",
    registrationIdentity: "git-registration:cleanup",
    ...(input.projectRootPath === true ? { path: config.projects[0].root } : {}),
    dirty: input.dirty ?? false,
    now,
  });
  const worktree = new FakeWorktreeProvider({
    now,
    worktrees: [worktreeObservation],
  });
  const terminalOptions: ConstructorParameters<typeof FakeTerminalProvider>[0] = {
    now,
    targets:
      input.state === "none"
        ? []
        : [
            createFakeTerminalTarget({
              id: "term_web_cleanup",
              projectId: "web",
              worktreeId: "wt_web_cleanup",
              sessionId: "ses_web_cleanup",
              harnessRunId: "run_web_cleanup",
              ...(input.terminalCloseable === undefined
                ? {}
                : { closeable: input.terminalCloseable }),
              now,
            }),
          ],
  };
  if (input.terminalCloseTargetMissing === true) {
    terminalOptions.failures = {
      closeTarget: {
        tag: "TerminalProviderError",
        code: "TERMINAL_TARGET_MISSING",
        message: "No live host PTY for this station target.",
        provider: "native",
        worktreeId: "wt_web_cleanup",
      },
    };
  }
  const terminal = new FakeTerminalProvider(terminalOptions);
  const harness = new FakeHarnessProvider({
    now,
    runs:
      input.state === "working" || input.state === "exited"
        ? [
            createFakeHarnessRun({
              id: "run_web_cleanup",
              projectId: "web",
              worktreeId: "wt_web_cleanup",
              sessionId: "ses_web_cleanup",
              state: input.state,
              now,
            }),
          ]
        : [],
  });
  const harnessProvider =
    input.harnessStopSupported === false ? withoutNativeStop(harness) : harness;
  const providers = new ProviderRegistry({
    worktree,
    terminal,
    harnesses: [harnessProvider],
  });
  const core = createObserverCore({ config, providers, persistence, clock });
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
  });
  return {
    sqlite,
    persistence,
    eventBus,
    queue,
    providers,
    core,
    worktree,
    worktreeObservation,
    terminal,
    harness,
  };
}

function withoutNativeStop(provider: FakeHarnessProvider): HarnessProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "stop") {
        return undefined;
      }
      if (property === "capabilities") {
        return () => ({ ...target.capabilities(), canStop: false });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
      defaultBranch: "main",
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
