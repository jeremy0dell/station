import type { StationConfig } from "@station/config";
import type { HarnessProvider, TerminalIntent, TerminalIntentReceipt } from "@station/contracts";
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
  type TerminalIntentRunner,
} from "../../src/internal";

const now = "2026-05-21T12:00:00.000Z";

describe("cleanup command handlers", () => {
  it("closes an active harness only after force and leaves the terminal open", async () => {
    const fixture = createFixture({ state: "working" });
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
    fixture.sqlite.close();
  });

  it("errors honestly on force close-harness when the provider cannot stop runs", async () => {
    const fixture = createFixture({ state: "working", harnessStopSupported: false });
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
    const fixture = createFixture({ state: "working" });
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
    const fixture = createFixture({ state: "working" });
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
    fixture.sqlite.close();
  });

  it("routes terminal focus and close through the command composition runner", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const fixture = createFixture({ state: "working", terminalIntentRunner });
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

    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "terminal.focus",
        commandId: focusReceipt.commandId,
        terminalProvider: "fake-terminal",
        subject: expect.objectContaining({ worktreeId: "wt_web_cleanup" }),
      }),
      expect.objectContaining({
        type: "terminal.close",
        commandId: closeReceipt.commandId,
        terminalProvider: "fake-terminal",
        subject: expect.objectContaining({ worktreeId: "wt_web_cleanup" }),
      }),
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    fixture.sqlite.close();
  });

  it("routes session terminal cleanup through the command composition runner", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const fixture = createFixture({ state: "working", terminalIntentRunner });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "session.close",
      payload: { sessionId: "ses_web_cleanup", mode: "terminal", force: true },
    });
    await fixture.queue.drain();

    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "terminal.close",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        subject: expect.objectContaining({ sessionId: "ses_web_cleanup" }),
      }),
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    fixture.sqlite.close();
  });

  it("rejects dirty worktree removal without force", async () => {
    const fixture = createFixture({ dirty: true, state: "none" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
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
    const fixture = createFixture({ state: "none", projectRootPath: true });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
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

  it("force-removes an active worktree after stopping harness and closing terminal", async () => {
    const fixture = createFixture({ dirty: true, state: "working" });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.harness.snapshot().stopped).toEqual([
      { runId: "run_web_cleanup", sessionId: "ses_web_cleanup", force: true },
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual(["term_web_cleanup"]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      { projectId: "web", worktreeId: "wt_web_cleanup", force: true },
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
    fixture.sqlite.close();
  });

  it("routes worktree terminal cleanup through the command composition runner", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const fixture = createFixture({ dirty: true, state: "working", terminalIntentRunner });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: { worktreeId: "wt_web_cleanup", projectId: "web", force: true },
    });
    await fixture.queue.drain();

    expect(terminalIntentRunner.intents).toEqual([
      expect.objectContaining({
        type: "terminal.close",
        commandId: receipt.commandId,
        terminalProvider: "fake-terminal",
        subject: expect.objectContaining({ worktreeId: "wt_web_cleanup" }),
      }),
    ]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([
      { projectId: "web", worktreeId: "wt_web_cleanup", force: true },
    ]);
    fixture.sqlite.close();
  });

  it("force-removes a worktree when terminal cleanup finds an already-missing target", async () => {
    const fixture = createFixture({
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
      { projectId: "web", worktreeId: "wt_web_cleanup", force: true },
    ]);
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });

  it("force-removes an active worktree when the terminal-owned harness cannot stop natively", async () => {
    const fixture = createFixture({ dirty: true, state: "working", harnessStopSupported: false });
    await fixture.core.reconcile("pre-cleanup");

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: "wt_web_cleanup",
        projectId: "web",
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
      { projectId: "web", worktreeId: "wt_web_cleanup", force: true },
    ]);
    fixture.sqlite.close();
  });
});

function createFixture(input: {
  dirty?: boolean;
  state: "none" | "working";
  harnessStopSupported?: boolean;
  terminalCloseTargetMissing?: boolean;
  projectRootPath?: boolean;
  terminalIntentRunner?: TerminalIntentRunner;
}) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({ persistence, clock, idFactory: ids, eventBus });
  const worktree = new FakeWorktreeProvider({
    now,
    worktrees: [
      createFakeWorktree({
        id: "wt_web_cleanup",
        projectId: "web",
        branch: "cleanup",
        ...(input.projectRootPath === true ? { path: config.projects[0].root } : {}),
        dirty: input.dirty ?? false,
        now,
      }),
    ],
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
      input.state === "none"
        ? []
        : [
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
  const harnessProvider =
    input.harnessStopSupported === false ? withoutNativeStop(harness) : harness;
  const providers = new ProviderRegistry({
    worktree,
    terminal,
    harnesses: [harnessProvider],
  });
  const core = createObserverCore({ config, providers, persistence, sqlite, clock });
  registerObserverCommandHandlers({
    queue,
    core,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
    ...(input.terminalIntentRunner === undefined
      ? {}
      : { terminalIntentRunner: input.terminalIntentRunner }),
  });
  return { sqlite, persistence, eventBus, queue, providers, core, worktree, terminal, harness };
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
