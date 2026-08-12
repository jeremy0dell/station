import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  HarnessProvider,
  ProviderProjectConfig,
  RemoveWorktreeRequest,
  StationEvent,
  TerminalIntent,
  TerminalIntentReceipt,
  WorktreeObservation,
  WorktreeProvider,
} from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createCommandQueue,
  createObserverCore,
  createObserverEventBus,
  createSqliteObserverPersistence,
  type ObserverCore,
  openObserverSqlite,
  ProviderRegistry,
  registerObserverCommandHandlers,
  type TerminalIntentRunner,
} from "../../src/internal";
import type { StationLogger } from "../../src/stationLogger.js";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter.js";

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
    const fixture = createFixture({ state: "terminal" });
    await fixture.persistence.persistReconcileResult({
      projects: config.projects,
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
    expect(fixture.core.getSnapshot().sessions).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended", endedAt: now }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("ends Station membership after session.close all succeeds", async () => {
    const fixture = createFixture({ state: "working" });
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

  it("rejects a worktree that becomes dirty after selection", async () => {
    const fixture = createFixture({ dirty: false, state: "none" });
    await fixture.core.reconcile("pre-cleanup");
    fixture.worktreeObservation.dirty = true;

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
      error: { code: "WORKTREE_DIRTY_REQUIRES_FORCE" },
    });
    expect(fixture.worktree.snapshot().removed).toEqual([]);
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
    const fixture = createFixture({ state: "working" });
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

  it("force-removes an active worktree after stopping harness and closing terminal", async () => {
    const fixture = createFixture({ dirty: true, state: "working" });
    await fixture.persistence.seedSession({
      sessionId: "ses_web_cleanup_older",
      projectId: "web",
      worktreeId: "wt_web_cleanup",
      initialTitle: "older cleanup session",
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
    await fixture.core.reconcile("verify-active-removal-convergence");
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

  it("completes confirmed removal before a blocked repair reconcile", async () => {
    let blockingProvider: BlockingPostRemoveProvider | undefined;
    const fixture = createFixture({
      state: "none",
      worktreeFactory: (observation) => {
        blockingProvider = new BlockingPostRemoveProvider(observation);
        return blockingProvider;
      },
    });
    await fixture.core.reconcile("pre-blocked-removal");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined || blockingProvider === undefined) {
      throw new Error("Expected a verified removal selection and blocking provider.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    const completion = fixture.queue.drain().then(() => true);
    await blockingProvider.postRemoveListStarted;
    let timeout: NodeJS.Timeout | undefined;
    const completedWhileBlocked = await Promise.race([
      completion,
      new Promise<false>((resolve) => {
        timeout = setTimeout(resolve, 100, false);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    const rowsWhileBlocked = fixture.core.getSnapshot().rows.length;
    const eventsWhileBlocked = await fixture.persistence.listEvents({
      commandId: receipt.commandId,
    });
    const reconciledEvents = fixture.eventBus
      .subscribe({ type: "observer.reconciled" })
      [Symbol.asyncIterator]();
    blockingProvider.releasePostRemoveList();
    await completion;
    await reconciledEvents.next();
    await reconciledEvents.return?.();

    expect(completedWhileBlocked).toBe(true);
    expect(rowsWhileBlocked).toBe(1);
    expect(eventsWhileBlocked).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree.removed" })]),
    );
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(blockingProvider.snapshot().removed).toHaveLength(1);
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });

  it("retains list-backed removal preflight when targeted lookup is unavailable", async () => {
    let blockingProvider: BlockingPostRemoveProvider | undefined;
    const fixture = createFixture({
      state: "none",
      targetedLookupSupported: false,
      worktreeFactory: (observation) => {
        blockingProvider = new BlockingPostRemoveProvider(observation);
        return blockingProvider;
      },
    });
    await fixture.core.reconcile("pre-fallback-removal");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined || blockingProvider === undefined) {
      throw new Error("Expected a verified removal selection and blocking provider.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    const completion = fixture.queue.drain().then(() => true);
    await blockingProvider.postRemoveListStarted;
    const completedWhileBlocked = await Promise.race([
      completion,
      new Promise<false>((resolve) => setTimeout(resolve, 50, false)),
    ]);
    expect(completedWhileBlocked).toBe(false);
    expect(blockingProvider.snapshot().removed).toEqual([]);

    blockingProvider.releasePostRemoveList();
    await completion;
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(blockingProvider.snapshot().removed).toHaveLength(1);
    fixture.sqlite.close();
  });

  it("keeps confirmed removal successful when deferred reconcile fails", async () => {
    const loggedErrors: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const logger: StationLogger = {
      async info(): Promise<void> {},
      async warn(): Promise<void> {},
      async error(message, attributes): Promise<void> {
        loggedErrors.push({ message, ...(attributes === undefined ? {} : { attributes }) });
      },
    };
    const fixture = createFixture({
      state: "none",
      postRemoveReconcileFailure: new Error("injected repair failure"),
      logger,
    });
    await fixture.core.reconcile("pre-failed-removal-repair");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.worktree.snapshot().removed).toHaveLength(1);
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree.removed" })]),
    );
    await vi.waitFor(() => {
      expect(loggedErrors).toEqual([
        expect.objectContaining({
          message: "Deferred worktree removal convergence failed.",
          attributes: expect.objectContaining({
            commandId: receipt.commandId,
            worktreeId: selected.id,
            error: expect.any(Error),
          }),
        }),
      ]);
    });
    await fixture.core.reconcile("explicit-repair-after-failure");
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });

  it("keeps confirmed removal successful when queue shutdown races its return", async () => {
    let shutdownProvider: ShutdownAfterConfirmedRemoveProvider | undefined;
    const fixture = createFixture({
      state: "working",
      worktreeFactory: (observation) => {
        shutdownProvider = new ShutdownAfterConfirmedRemoveProvider(observation);
        return shutdownProvider;
      },
    });
    await fixture.core.reconcile("pre-shutdown-race-removal");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined || shutdownProvider === undefined) {
      throw new Error("Expected a verified removal selection and shutdown provider.");
    }

    let shutdown: Promise<void> | undefined;
    shutdownProvider.onConfirmedRemoval = () => {
      shutdown = fixture.queue.shutdown();
    };
    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();
    await shutdown;

    expect(shutdown).toBeDefined();
    expect(shutdownProvider.snapshot().removed).toHaveLength(1);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.removed" }),
        expect.objectContaining({ type: "worktree.removed" }),
      ]),
    );
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended" }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("drains confirmed removal classification after the command deadline", async () => {
    const fixture = createFixture({
      state: "working",
      commandTimeoutMs: 15,
      worktreeRetirementDelayMs: 45,
    });
    await fixture.core.reconcile("pre-post-removal-timeout");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.worktree.snapshot().removed).toHaveLength(1);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.removed" }),
        expect.objectContaining({ type: "worktree.removed" }),
        expect.objectContaining({ type: "command.succeeded" }),
      ]),
    );
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended" }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("retries transient confirmed-removal retirement before publishing evidence", async () => {
    const fixture = createFixture({ state: "working", worktreeRetirementFailures: 1 });
    await fixture.core.reconcile("pre-transient-retirement-failure");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.worktree.snapshot().removed).toHaveLength(1);
    expect(fixture.worktreeRetirementAttempts()).toBe(2);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session.removed" }),
        expect.objectContaining({ type: "worktree.removed" }),
      ]),
    );
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended" }),
      ]),
    );
    fixture.sqlite.close();
  });

  it("keeps persistent confirmed-removal retirement failure explicit and evidence-free", async () => {
    const fixture = createFixture({
      state: "working",
      worktreeRetirementFailures: "persistent",
    });
    await fixture.core.reconcile("pre-persistent-retirement-failure");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    expect(fixture.worktree.snapshot().removed).toHaveLength(1);
    expect(fixture.worktreeRetirementAttempts()).toBe(2);
    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKTREE_REMOVE_RETIREMENT_FAILED" },
    });
    expect(
      (await fixture.persistence.listEvents({ commandId: receipt.commandId })).filter((event) =>
        event.type.endsWith(".removed"),
      ),
    ).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "open" }),
      ]),
    );
    expect(fixture.core.getSnapshot().rows).toHaveLength(1);
    fixture.sqlite.close();
  });

  it("repairs a durable confirmed-removal retirement failure without repeating cleanup", async () => {
    const fixture = createFixture({
      state: "working",
      worktreeRetirementFailures: 2,
    });
    await fixture.core.reconcile("pre-durable-retirement-repair");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }
    const command = {
      type: "worktree.remove" as const,
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    };
    const operationId = "cleanup-durable-retirement-repair";

    const original = await fixture.queue.dispatch(command, { operationId });
    await fixture.queue.drain();
    await expect(fixture.persistence.getCommand(original.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKTREE_REMOVE_RETIREMENT_FAILED" },
    });
    expect(fixture.worktreeRetirementAttempts()).toBe(2);
    const cleanupBefore = {
      removed: fixture.worktree.snapshot().removed,
      stopped: fixture.harness.snapshot().stopped,
      closed: fixture.terminal.snapshot().closed,
    };

    const [first, concurrent] = await Promise.all([
      fixture.queue.dispatch(command, { operationId }),
      fixture.queue.dispatch(command, { operationId }),
    ]);
    await fixture.queue.drain();

    expect(concurrent).toEqual(first);
    expect(fixture.worktreeRetirementAttempts()).toBe(3);
    expect({
      removed: fixture.worktree.snapshot().removed,
      stopped: fixture.harness.snapshot().stopped,
      closed: fixture.terminal.snapshot().closed,
    }).toEqual(cleanupBefore);
    await expect(fixture.persistence.getCommand(original.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      fixture.persistence.listEvents({ commandId: original.commandId }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "command.failed" }),
        expect.objectContaining({ type: "session.removed" }),
        expect.objectContaining({ type: "worktree.removed" }),
        expect.objectContaining({ type: "command.succeeded" }),
      ]),
    );
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "ended" }),
      ]),
    );
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toEqual([]);
    await vi.waitFor(() => expect(fixture.core.getSnapshot().rows).toEqual([]));
    fixture.sqlite.close();
  });

  it("attempts persistent durable retirement recovery once per queue lifetime", async () => {
    const fixture = createFixture({
      state: "working",
      worktreeRetirementFailures: "persistent",
    });
    await fixture.core.reconcile("pre-persistent-durable-retirement-repair");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }
    const command = {
      type: "worktree.remove" as const,
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    };
    const operationId = "cleanup-persistent-durable-retirement-repair";

    const original = await fixture.queue.dispatch(command, { operationId });
    await fixture.queue.drain();
    const cleanupBefore = {
      removed: fixture.worktree.snapshot().removed,
      stopped: fixture.harness.snapshot().stopped,
      closed: fixture.terminal.snapshot().closed,
    };
    await Promise.all([
      fixture.queue.dispatch(command, { operationId }),
      fixture.queue.dispatch(command, { operationId }),
    ]);
    await fixture.queue.drain();

    expect(fixture.worktreeRetirementAttempts()).toBe(4);
    expect({
      removed: fixture.worktree.snapshot().removed,
      stopped: fixture.harness.snapshot().stopped,
      closed: fixture.terminal.snapshot().closed,
    }).toEqual(cleanupBefore);
    await expect(fixture.persistence.getCommand(original.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKTREE_REMOVE_RETIREMENT_FAILED" },
    });
    expect(
      (await fixture.persistence.listEvents({ commandId: original.commandId })).filter((event) =>
        event.type.endsWith(".removed"),
      ),
    ).toEqual([]);
    await expect(fixture.persistence.listSessions()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ses_web_cleanup", lifecycle: "open" }),
      ]),
    );
    await expect(fixture.persistence.listWorktreeDisplayTitles()).resolves.toHaveLength(1);
    fixture.sqlite.close();
  });

  it("does not commit cancellation handling when the provider declines removal", async () => {
    const fixture = createFixture({
      state: "none",
      worktreeFactory: (observation) => new NotConfirmedRemovalProvider(observation),
    });
    await fixture.core.reconcile("pre-unconfirmed-removal");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const command = {
      type: "worktree.remove" as const,
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    };
    const operationId = "cleanup-provider-declined-removal";
    const receipt = await fixture.queue.dispatch(command, { operationId });
    await fixture.queue.drain();
    await fixture.queue.dispatch(command, { operationId });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "failed",
      error: { code: "WORKTREE_REMOVE_NOT_CONFIRMED" },
    });
    expect(fixture.worktree.snapshot().worktrees).toHaveLength(1);
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    expect(fixture.worktreeRetirementAttempts()).toBe(0);
    await expect(
      fixture.persistence.listEvents({ commandId: receipt.commandId }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree.removed" })]),
    );
    fixture.sqlite.close();
  });

  it("repairs a partial confirmed-removal event write without duplication", async () => {
    const fixture = createFixture({ state: "working", worktreeRemovalEventFailures: 1 });
    await fixture.core.reconcile("pre-removal-event-repair");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.worktreeRemovalEventAttempts()).toBe(2);
    const removalEvents = (
      await fixture.persistence.listEvents({ commandId: receipt.commandId })
    ).filter((event) => event.type.endsWith(".removed"));
    expect(removalEvents.map((event) => event.type)).toEqual([
      "session.removed",
      "worktree.removed",
    ]);
    await vi.waitFor(() => expect(fixture.core.getSnapshot().rows).toEqual([]));
    fixture.sqlite.close();
  });

  it("keeps confirmed removal successful when event persistence stays degraded", async () => {
    const loggedErrors: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const logger: StationLogger = {
      async info(): Promise<void> {},
      async warn(): Promise<void> {},
      async error(message, attributes): Promise<void> {
        loggedErrors.push({ message, ...(attributes === undefined ? {} : { attributes }) });
      },
    };
    const fixture = createFixture({
      state: "working",
      worktreeRemovalEventFailures: "persistent",
      logger,
    });
    await fixture.core.reconcile("pre-persistent-removal-event-failure");
    const selected = fixture.core.getSnapshot().rows[0];
    if (selected?.registrationIdentity === undefined) {
      throw new Error("Expected a verified removal selection.");
    }

    const receipt = await fixture.queue.dispatch({
      type: "worktree.remove",
      payload: {
        worktreeId: selected.id,
        projectId: selected.projectId,
        expectedPath: selected.path,
        expectedBranch: selected.branch,
        expectedRegistrationIdentity: selected.registrationIdentity,
        force: true,
      },
    });
    await fixture.queue.drain();

    await expect(fixture.persistence.getCommand(receipt.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.worktreeRemovalEventAttempts()).toBe(2);
    await expect(fixture.persistence.listEvents({ commandId: receipt.commandId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session.removed" })]),
    );
    await expect(
      fixture.persistence.listEvents({ commandId: receipt.commandId }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree.removed" })]),
    );
    await vi.waitFor(() => expect(fixture.core.getSnapshot().rows).toEqual([]));
    expect(loggedErrors).toEqual([
      expect.objectContaining({
        message: "Confirmed worktree removal event publication failed.",
        attributes: expect.objectContaining({
          commandId: receipt.commandId,
          worktreeId: selected.id,
          error: expect.any(Error),
        }),
      }),
    ]);
    fixture.sqlite.close();
  });

  it("routes worktree terminal cleanup through the command composition runner", async () => {
    const terminalIntentRunner = new CapturingTerminalIntentRunner();
    const fixture = createFixture({ dirty: true, state: "working", terminalIntentRunner });
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
      {
        projectId: "web",
        worktreeId: "wt_web_cleanup",
        expectedPath: "/tmp/station/web/cleanup",
        expectedBranch: "cleanup",
        expectedRegistrationIdentity: "git-registration:cleanup",
        force: true,
      },
    ]);
    await fixture.core.reconcile("verify-composed-removal-convergence");
    fixture.sqlite.close();
  });

  it("removes a clean exited worktree when terminal cleanup finds an already-missing target", async () => {
    const fixture = createFixture({
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
    await fixture.core.reconcile("verify-exited-removal-convergence");
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
    await fixture.core.reconcile("verify-missing-target-removal-convergence");
    expect(fixture.core.getSnapshot().rows).toEqual([]);
    fixture.sqlite.close();
  });

  it("force-removes an active worktree when the terminal-owned harness cannot stop natively", async () => {
    const fixture = createFixture({
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
    await fixture.core.reconcile("verify-stopless-removal-convergence");
    fixture.sqlite.close();
  });

  it("refuses active worktree removal when neither harness nor terminal can stop it", async () => {
    const fixture = createFixture({
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
      error: { code: "HARNESS_STOP_UNSUPPORTED" },
    });
    expect(fixture.harness.snapshot().stopped).toEqual([]);
    expect(fixture.terminal.snapshot().closed).toEqual([]);
    expect(fixture.worktree.snapshot().removed).toEqual([]);
    fixture.sqlite.close();
  });
});

function createFixture(input: {
  dirty?: boolean;
  state: "none" | "terminal" | "working" | "exited";
  harnessStopSupported?: boolean;
  terminalCloseable?: boolean;
  terminalCloseTargetMissing?: boolean;
  projectRootPath?: boolean;
  terminalIntentRunner?: TerminalIntentRunner;
  worktreeFactory?: (observation: WorktreeObservation) => FakeWorktreeProvider;
  targetedLookupSupported?: boolean;
  worktreeRemovalEventFailures?: number | "persistent";
  worktreeRetirementFailures?: number | "persistent";
  worktreeRetirementDelayMs?: number;
  postRemoveReconcileFailure?: Error;
  logger?: StationLogger;
  commandTimeoutMs?: number;
}) {
  const clock = { now: () => new Date(now) };
  const sqlite = openObserverSqlite({ clock });
  const ids = observerIds();
  const persistence = createSqliteObserverPersistence({ sqlite, clock, idFactory: ids });
  let worktreeRemovalEventAttempts = 0;
  let worktreeRetirementAttempts = 0;
  const commandPersistence = {
    ...persistence,
    recordEvent: async (
      event: StationEvent,
      options?: Parameters<typeof persistence.recordEvent>[1],
    ) => {
      if (event.type === "worktree.removed") {
        worktreeRemovalEventAttempts += 1;
        if (
          input.worktreeRemovalEventFailures === "persistent" ||
          (input.worktreeRemovalEventFailures !== undefined &&
            worktreeRemovalEventAttempts <= input.worktreeRemovalEventFailures)
        ) {
          throw new Error("injected worktree.removed persistence failure");
        }
      }
      return persistence.recordEvent(event, options);
    },
    retireRemovedWorktreeSessionState: async (
      retirement: Parameters<typeof persistence.retireRemovedWorktreeSessionState>[0],
    ) => {
      worktreeRetirementAttempts += 1;
      if (input.worktreeRetirementDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, input.worktreeRetirementDelayMs));
      }
      if (
        input.worktreeRetirementFailures === "persistent" ||
        (input.worktreeRetirementFailures !== undefined &&
          worktreeRetirementAttempts <= input.worktreeRetirementFailures)
      ) {
        throw new Error("injected worktree retirement persistence failure");
      }
      return persistence.retireRemovedWorktreeSessionState(retirement);
    },
  };
  const eventBus = createObserverEventBus();
  const queue = createCommandQueue({
    persistence: commandPersistence,
    clock,
    idFactory: ids,
    eventBus,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: input.commandTimeoutMs }),
  });
  const worktreeObservation = createFakeWorktree({
    id: "wt_web_cleanup",
    projectId: "web",
    branch: "cleanup",
    registrationIdentity: "git-registration:cleanup",
    ...(input.projectRootPath === true ? { path: config.projects[0].root } : {}),
    dirty: input.dirty ?? false,
    now,
  });
  const worktree =
    input.worktreeFactory?.(worktreeObservation) ??
    new FakeWorktreeProvider({
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
  const worktreeProvider =
    input.targetedLookupSupported === false ? withoutTargetedLookup(worktree) : worktree;
  const providers = new ProviderRegistry({
    worktree: worktreeProvider,
    terminal,
    harnesses: [harnessProvider],
  });
  const baseCore = createObserverCore({
    config,
    providers,
    persistence: commandPersistence,
    clock,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: input.commandTimeoutMs }),
  });
  const core: ObserverCore =
    input.postRemoveReconcileFailure === undefined
      ? baseCore
      : {
          ...baseCore,
          reconcile: (reason) =>
            reason === "command:worktree.remove"
              ? Promise.reject(input.postRemoveReconcileFailure)
              : baseCore.reconcile(reason),
        };
  registerObserverCommandHandlers({
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
    queue,
    core,
    providers,
    projects: config.projects,
    persistence: commandPersistence,
    eventBus,
    clock,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.terminalIntentRunner === undefined
      ? {}
      : { terminalIntentRunner: input.terminalIntentRunner }),
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
    worktreeRemovalEventAttempts: () => worktreeRemovalEventAttempts,
    worktreeRetirementAttempts: () => worktreeRetirementAttempts,
    terminal,
    harness,
  };
}

class BlockingPostRemoveProvider extends FakeWorktreeProvider {
  listCalls = 0;
  readonly postRemoveListStarted: Promise<void>;
  #markPostRemoveListStarted: (() => void) | undefined;
  #releasePostRemoveList: (() => void) | undefined;
  readonly #postRemoveListRelease: Promise<void>;

  constructor(worktree: WorktreeObservation) {
    super({ now, worktrees: [worktree] });
    this.postRemoveListStarted = new Promise((resolve) => {
      this.#markPostRemoveListStarted = resolve;
    });
    this.#postRemoveListRelease = new Promise((resolve) => {
      this.#releasePostRemoveList = resolve;
    });
  }

  releasePostRemoveList(): void {
    this.#releasePostRemoveList?.();
  }

  override async listWorktrees(project: ProviderProjectConfig): Promise<WorktreeObservation[]> {
    this.listCalls += 1;
    if (this.listCalls === 2) {
      this.#markPostRemoveListStarted?.();
      await this.#postRemoveListRelease;
    }
    return super.listWorktrees(project);
  }
}

class ShutdownAfterConfirmedRemoveProvider extends FakeWorktreeProvider {
  onConfirmedRemoval: (() => void) | undefined;

  constructor(worktree: WorktreeObservation) {
    super({ now, worktrees: [worktree] });
  }

  override async removeWorktree(request: RemoveWorktreeRequest) {
    const result = await super.removeWorktree(request);
    this.onConfirmedRemoval?.();
    return result;
  }
}

class NotConfirmedRemovalProvider extends FakeWorktreeProvider {
  constructor(worktree: WorktreeObservation) {
    super({ now, worktrees: [worktree] });
  }

  override async removeWorktree(request: RemoveWorktreeRequest) {
    return { worktreeId: request.worktreeId, removed: false, reason: "injected refusal" };
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

function withoutTargetedLookup(provider: FakeWorktreeProvider): WorktreeProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === "getWorktree") return undefined;
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
