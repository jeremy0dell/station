import { createHash } from "node:crypto";
import type { ErrorEnvelope, SafeError, StationCommand, StationEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createCommandQueue } from "../../src/commands/queue";
import { createSqliteObserverPersistence } from "../../src/persistence";
import { openObserverSqlite } from "../../src/sqlite";

const now = "2026-05-20T12:00:00.000Z";

function commandIds() {
  let command = 0;
  let event = 0;
  let error = 0;
  return {
    commandId: () => {
      command += 1;
      return `cmd_${command}`;
    },
    eventId: () => {
      event += 1;
      return `evt_${event}`;
    },
    errorId: () => {
      error += 1;
      return `err_${error}`;
    },
  };
}

function createPersistenceAndQueue(options: { commandTimeoutMs?: number } = {}) {
  const ids = commandIds();
  const sqlite = openObserverSqlite({ clock: { now: () => new Date(now) } });
  const persistence = createSqliteObserverPersistence({
    sqlite,
    clock: { now: () => new Date(now) },
    idFactory: ids,
  });
  const queue = createCommandQueue({
    persistence,
    clock: { now: () => new Date(now) },
    idFactory: ids,
    ...options,
  });
  return { sqlite, persistence, queue };
}

const reconcileCommand: StationCommand = {
  type: "observer.reconcile",
  payload: {
    reason: "queue-test",
  },
};

const renameSessionCommand: StationCommand = {
  type: "session.rename",
  payload: {
    sessionId: "ses_web_main",
    title: "Web main",
  },
};

const createWorktreeCommand: StationCommand = {
  type: "worktree.create",
  payload: {
    projectId: "web",
    branch: "feature/auth",
  },
};

const closeTerminalCommand: StationCommand = {
  type: "terminal.close",
  payload: {
    sessionId: "ses_web_main",
  },
};

const createSessionGroupCommand: StationCommand = {
  type: "sessionGroup.create",
  payload: {
    projectId: "web",
    name: "Another web Group",
  },
};

const reparentSessionGroupCommand: StationCommand = {
  type: "sessionGroup.reparent",
  payload: {
    projectId: "web",
    groupId: "grp_web",
    expectedVersion: 1,
    parentGroupId: "grp_parent",
  },
};

const createApiSessionGroupCommand: StationCommand = {
  type: "sessionGroup.create",
  payload: {
    projectId: "api",
    name: "API Group",
  },
};

const removeWorktreeCommand: StationCommand = {
  type: "worktree.remove",
  payload: {
    projectId: "web",
    worktreeId: "wt_feature_auth",
    expectedPath: "/tmp/station/web/feature-auth",
    expectedBranch: "feature/auth",
    expectedRegistrationIdentity: "git-registration:feature-auth",
    force: true,
  },
};

function commandIdForOperation(operationId: string) {
  return `cmd_op_${createHash("sha256").update(operationId).digest("hex")}`;
}

describe("observer command queue", () => {
  it("returns the original durable receipt when an operation is replayed after queue reconstruction", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    const handler = async ({ commandId }: { commandId: string }) => {
      handled.push(commandId);
    };
    queue.registerHandler("observer.reconcile", handler);

    const first = await queue.dispatch(reconcileCommand, {
      operationId: "req_lost_response",
    });
    await queue.drain();

    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("observer.reconcile", handler);
    const replay = await reconstructed.dispatch(reconcileCommand, {
      operationId: "req_lost_response",
    });
    await reconstructed.drain();

    expect(replay).toEqual(first);
    expect(handled).toEqual([first.commandId]);
    expect(await persistence.listCommands()).toHaveLength(1);
    sqlite.close();
  });

  it("recovers a stranded accepted operation exactly once after queue reconstruction", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    let injected = false;
    const faultPersistence = {
      ...persistence,
      recordEvent: async (
        event: StationEvent,
        options?: Parameters<typeof persistence.recordEvent>[1],
      ) => {
        if (!injected && event.type === "command.accepted") {
          injected = true;
          throw new Error("injected accepted-event write failure");
        }
        return persistence.recordEvent(event, options);
      },
    };
    const interrupted = createCommandQueue({
      persistence: faultPersistence,
      clock: { now: () => new Date(now) },
    });
    interrupted.registerHandler("observer.reconcile", async () => undefined);

    await expect(
      interrupted.dispatch(reconcileCommand, { operationId: "req_stranded_accepted" }),
    ).rejects.toThrow("injected accepted-event write failure");
    await interrupted.shutdown();
    await expect(persistence.listCommands()).resolves.toEqual([
      expect.objectContaining({ status: "accepted" }),
    ]);

    const handled: string[] = [];
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("observer.reconcile", async ({ commandId }) => {
      handled.push(commandId);
    });
    const [first, concurrent] = await Promise.all([
      reconstructed.dispatch(reconcileCommand, { operationId: "req_stranded_accepted" }),
      reconstructed.dispatch(reconcileCommand, { operationId: "req_stranded_accepted" }),
    ]);
    await reconstructed.drain();

    expect(concurrent).toEqual(first);
    expect(handled).toEqual([first.commandId]);
    await expect(persistence.getCommand(first.commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(persistence.listEvents({ commandId: first.commandId })).resolves.toEqual([
      expect.objectContaining({ type: "command.accepted" }),
      expect.objectContaining({ type: "command.started" }),
      expect.objectContaining({ type: "command.succeeded" }),
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("does not replay a started operation through another queue", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    let release = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    queue.registerHandler("observer.reconcile", async () => {
      markStarted();
      await blocked;
    });
    const first = await queue.dispatch(reconcileCommand, {
      operationId: "req_started_not_replayable",
    });
    await started;
    await expect(persistence.getCommand(first.commandId)).resolves.toMatchObject({
      status: "started",
    });

    let replayHandled = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("observer.reconcile", async () => {
      replayHandled += 1;
    });
    const replay = await reconstructed.dispatch(reconcileCommand, {
      operationId: "req_started_not_replayable",
    });
    await reconstructed.drain();

    expect(replay).toEqual(first);
    expect(replayHandled).toBe(0);
    release();
    await queue.drain();
    await reconstructed.shutdown();
    await queue.shutdown();
    sqlite.close();
  });

  it("terminalizes a started removal only from matching command-correlated evidence", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const operationId = "req_started_remove_with_evidence";
    const commandId = commandIdForOperation(operationId);
    await persistence.recordCommandAccepted({ commandId, command: removeWorktreeCommand });
    await persistence.markCommandStarted(commandId);
    await persistence.recordEvent(
      { type: "worktree.removed", worktreeId: "wt_unrelated" },
      { commandId },
    );
    let replayHandled = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("worktree.remove", async () => {
      replayHandled += 1;
    });

    await reconstructed.dispatch(removeWorktreeCommand, { operationId });
    await expect(persistence.getCommand(commandId)).resolves.toMatchObject({ status: "started" });
    await persistence.recordEvent(
      { type: "worktree.removed", worktreeId: "wt_feature_auth" },
      { commandId },
    );

    const [first, concurrent] = await Promise.all([
      reconstructed.dispatch(removeWorktreeCommand, { operationId }),
      reconstructed.dispatch(removeWorktreeCommand, { operationId }),
    ]);
    await reconstructed.drain();

    expect(concurrent).toEqual(first);
    expect(replayHandled).toBe(0);
    await expect(persistence.getCommand(commandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(
      (await persistence.listEvents({ commandId })).filter(
        (event) => event.type === "command.succeeded",
      ),
    ).toHaveLength(1);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("repairs a missing success event for a terminal operation replay", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const operationId = "req_succeeded_missing_event";
    const commandId = commandIdForOperation(operationId);
    await persistence.recordCommandAccepted({ commandId, command: reconcileCommand });
    await persistence.markCommandStarted(commandId);
    await persistence.markCommandSucceeded(commandId);
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });

    await reconstructed.dispatch(reconcileCommand, { operationId });
    await reconstructed.dispatch(reconcileCommand, { operationId });

    expect(
      (await persistence.listEvents({ commandId })).filter(
        (event) => event.type === "command.succeeded",
      ),
    ).toHaveLength(1);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("repairs a missing failure event for a terminal operation replay without replaying its handler", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const operationId = "req_failed_missing_event";
    let injected = false;
    const faultPersistence = {
      ...persistence,
      recordEvent: async (
        event: StationEvent,
        options?: Parameters<typeof persistence.recordEvent>[1],
      ) => {
        if (!injected && event.type === "command.failed") {
          injected = true;
          throw new Error("injected failed-event write failure");
        }
        return persistence.recordEvent(event, options);
      },
    };
    const interrupted = createCommandQueue({
      persistence: faultPersistence,
      clock: { now: () => new Date(now) },
      idFactory: { errorId: () => "err_failed_missing_event" },
    });
    interrupted.registerHandler("observer.reconcile", async () => {
      throw {
        tag: "CommandExecutionError",
        code: "EXPECTED_FAILURE",
        message: "Expected queue failure.",
      };
    });

    const first = await interrupted.dispatch(reconcileCommand, { operationId });
    await interrupted.drain();
    await interrupted.shutdown();
    const failed = await persistence.getCommand(first.commandId);
    expect(failed).toMatchObject({ status: "failed", error: { code: "EXPECTED_FAILURE" } });
    await expect(
      persistence.listEvents({ commandId: first.commandId, type: "command.failed" }),
    ).resolves.toHaveLength(0);

    let replayHandled = 0;
    const published: StationEvent[] = [];
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
      eventBus: { publish: (event) => published.push(event) },
    });
    reconstructed.registerHandler("observer.reconcile", async () => {
      replayHandled += 1;
    });
    const [replay, concurrent] = await Promise.all([
      reconstructed.dispatch(reconcileCommand, { operationId }),
      reconstructed.dispatch(reconcileCommand, { operationId }),
    ]);

    expect(concurrent).toEqual(replay);
    expect(replayHandled).toBe(0);
    await expect(
      persistence.listEvents({ commandId: first.commandId, type: "command.failed" }),
    ).resolves.toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "command.failed",
          commandId: first.commandId,
          error: failed?.error,
        }),
      }),
    ]);
    expect(published).toEqual([
      expect.objectContaining({ type: "command.failed", error: failed?.error }),
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("runs one recovery-only handler for concurrent exact replay of a durable failure", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const operationId = "req_failed_recovery_only";
    const commandId = commandIdForOperation(operationId);
    const safeError: SafeError = {
      tag: "PersistenceError",
      code: "REPAIRABLE_FAILURE",
      message: "Repairable terminal failure.",
    };
    const envelope: ErrorEnvelope = {
      id: "err_repairable",
      tag: safeError.tag,
      code: safeError.code,
      message: safeError.message,
      severity: "error",
      commandId,
      redacted: true,
      createdAt: now,
    };
    await persistence.recordCommandAccepted({ commandId, command: reconcileCommand });
    await persistence.markCommandStarted(commandId);
    await persistence.markCommandFailed({ commandId, safeError, envelope });
    await persistence.recordEvent(
      { type: "command.failed", commandId, error: safeError },
      { commandId },
    );
    let ordinaryHandlerCalls = 0;
    let recoveryHandlerCalls = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("observer.reconcile", async () => {
      ordinaryHandlerCalls += 1;
    });
    reconstructed.registerRecoveryHandler("observer.reconcile", async () => {
      recoveryHandlerCalls += 1;
      return "recovered";
    });

    await Promise.all([
      reconstructed.dispatch(reconcileCommand, { operationId }),
      reconstructed.dispatch(reconcileCommand, { operationId }),
    ]);

    expect(ordinaryHandlerCalls).toBe(0);
    expect(recoveryHandlerCalls).toBe(1);
    await expect(persistence.getCommand(commandId)).resolves.toMatchObject({ status: "succeeded" });
    expect((await persistence.listEvents({ commandId })).map((event) => event.type)).toEqual([
      "command.failed",
      "command.succeeded",
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("recovers registered durable failures without replay and isolates a failed repair", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const recoverOperationId = "req_startup_recover";
    const failingOperationId = "req_startup_recovery_failure";
    const unrelatedOperationId = "req_startup_unrelated_failure";
    const recoverCommandId = commandIdForOperation(recoverOperationId);
    const failingCommandId = commandIdForOperation(failingOperationId);
    const unrelatedCommandId = commandIdForOperation(unrelatedOperationId);
    for (const [commandId, command, code] of [
      [recoverCommandId, reconcileCommand, "RECOVER_ME"],
      [failingCommandId, reconcileCommand, "RECOVERY_THROWS"],
      [unrelatedCommandId, renameSessionCommand, "UNREGISTERED_TYPE"],
    ] as const) {
      await persistence.recordCommandAccepted({ commandId, command, createdAt: now });
      await persistence.markCommandStarted(commandId, now);
      const error: SafeError = {
        tag: "CommandExecutionError",
        code,
        message: code,
      };
      await persistence.markCommandFailed({
        commandId,
        safeError: error,
        envelope: {
          id: `err_${code}`,
          tag: error.tag,
          code: error.code,
          message: error.message,
          severity: "error",
          commandId,
          redacted: true,
          createdAt: now,
        },
        finishedAt: now,
      });
      await persistence.recordEvent({ type: "command.failed", commandId, error }, { commandId });
    }

    let ordinaryHandlerCalls = 0;
    let recoveryHandlerCalls = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("observer.reconcile", async () => {
      ordinaryHandlerCalls += 1;
    });
    reconstructed.registerRecoveryHandler("observer.reconcile", async ({ error }) => {
      recoveryHandlerCalls += 1;
      if (error.code === "RECOVERY_THROWS") throw new Error("injected recovery failure");
      return "recovered";
    });

    await reconstructed.recoverDurableCommands();

    expect(ordinaryHandlerCalls).toBe(0);
    expect(recoveryHandlerCalls).toBe(2);
    await expect(persistence.getCommand(recoverCommandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(persistence.getCommand(failingCommandId)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(persistence.getCommand(unrelatedCommandId)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      persistence.listEvents({ commandId: recoverCommandId, type: "command.succeeded" }),
    ).resolves.toHaveLength(1);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("resumes accepted work and repairs evidence-backed records during durable recovery", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const startedOperationId = "req_startup_started_remove_with_evidence";
    const succeededOperationId = "req_startup_succeeded_missing_event";
    const ambiguousOperationId = "req_startup_started_remove_without_evidence";
    const acceptedOperationId = "req_startup_accepted_control";
    const startedCommandId = commandIdForOperation(startedOperationId);
    const succeededCommandId = commandIdForOperation(succeededOperationId);
    const ambiguousCommandId = commandIdForOperation(ambiguousOperationId);
    const acceptedCommandId = commandIdForOperation(acceptedOperationId);
    await persistence.recordCommandAccepted({
      commandId: startedCommandId,
      command: removeWorktreeCommand,
      createdAt: now,
    });
    await persistence.markCommandStarted(startedCommandId, now);
    await persistence.recordEvent(
      { type: "worktree.removed", worktreeId: removeWorktreeCommand.payload.worktreeId },
      { commandId: startedCommandId },
    );
    await persistence.recordCommandAccepted({
      commandId: succeededCommandId,
      command: reconcileCommand,
      createdAt: now,
    });
    await persistence.markCommandStarted(succeededCommandId, now);
    await persistence.markCommandSucceeded(succeededCommandId, now);
    await persistence.recordCommandAccepted({
      commandId: ambiguousCommandId,
      command: removeWorktreeCommand,
      createdAt: now,
    });
    await persistence.markCommandStarted(ambiguousCommandId, now);
    await persistence.recordCommandAccepted({
      commandId: acceptedCommandId,
      command: reconcileCommand,
      createdAt: now,
    });

    let ordinaryHandlerCalls = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("worktree.remove", async () => {
      ordinaryHandlerCalls += 1;
    });
    reconstructed.registerHandler("observer.reconcile", async () => {
      ordinaryHandlerCalls += 1;
    });

    await reconstructed.recoverDurableCommands();

    expect(ordinaryHandlerCalls).toBe(1);
    await expect(persistence.getCommand(startedCommandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(persistence.getCommand(succeededCommandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(persistence.getCommand(ambiguousCommandId)).resolves.toMatchObject({
      status: "started",
    });
    await expect(persistence.getCommand(acceptedCommandId)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      persistence.listEvents({ commandId: startedCommandId, type: "command.succeeded" }),
    ).resolves.toHaveLength(1);
    await expect(
      persistence.listEvents({ commandId: succeededCommandId, type: "command.succeeded" }),
    ).resolves.toHaveLength(1);
    await expect(
      persistence.listEvents({ commandId: acceptedCommandId, type: "command.accepted" }),
    ).resolves.toHaveLength(1);
    await expect(
      persistence.listEvents({ commandId: acceptedCommandId, type: "command.succeeded" }),
    ).resolves.toHaveLength(1);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("re-reads accepted recovery state before scheduling it", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const commandId = "cmd_stale_accepted_recovery";
    await persistence.recordCommandAccepted({
      commandId,
      command: reconcileCommand,
      createdAt: now,
    });
    let statusReadReached = () => undefined;
    const statusRead = new Promise<void>((resolve) => {
      statusReadReached = resolve;
    });
    let releaseStatusRead = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseStatusRead = resolve;
    });
    let candidatesSelected = false;
    let blocked = false;
    const racePersistence = {
      ...persistence,
      listCommandRecoveryCandidates: async (
        input: Parameters<typeof persistence.listCommandRecoveryCandidates>[0],
      ) => {
        const candidates = await persistence.listCommandRecoveryCandidates(input);
        candidatesSelected = true;
        return candidates;
      },
      getCommand: async (selectedCommandId: Parameters<typeof persistence.getCommand>[0]) => {
        if (candidatesSelected && !blocked) {
          blocked = true;
          statusReadReached();
          await release;
        }
        return persistence.getCommand(selectedCommandId);
      },
    };
    let handlerCalls = 0;
    const reconstructed = createCommandQueue({ persistence: racePersistence });
    reconstructed.registerHandler("observer.reconcile", async () => {
      handlerCalls += 1;
    });

    const recovery = reconstructed.recoverDurableCommands();
    await statusRead;
    await persistence.markCommandSucceeded(commandId, now);
    releaseStatusRead();
    await recovery;

    expect(handlerCalls).toBe(0);
    expect((await persistence.listEvents({ commandId })).map(({ event }) => event.type)).toEqual([
      "command.succeeded",
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("repairs terminal state advanced during acceptance recovery", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const commandId = "cmd_advanced_during_acceptance_recovery";
    await persistence.recordCommandAccepted({
      commandId,
      command: reconcileCommand,
      createdAt: now,
    });
    let finalReadReached = () => undefined;
    const finalRead = new Promise<void>((resolve) => {
      finalReadReached = resolve;
    });
    let releaseFinalRead = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    let getCalls = 0;
    const racePersistence = {
      ...persistence,
      getCommand: async (selectedCommandId: Parameters<typeof persistence.getCommand>[0]) => {
        getCalls += 1;
        if (getCalls === 2) {
          finalReadReached();
          await release;
        }
        return persistence.getCommand(selectedCommandId);
      },
    };
    let handlerCalls = 0;
    const reconstructed = createCommandQueue({ persistence: racePersistence });
    reconstructed.registerHandler("observer.reconcile", async () => {
      handlerCalls += 1;
    });

    const recovery = reconstructed.recoverDurableCommands();
    await finalRead;
    await persistence.markCommandSucceeded(commandId, now);
    releaseFinalRead();
    await recovery;

    expect(handlerCalls).toBe(0);
    expect((await persistence.listEvents({ commandId })).map(({ event }) => event.type)).toEqual([
      "command.accepted",
      "command.succeeded",
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("stops admitting accepted recovery work after queue shutdown", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const commandIds = [
      "cmd_recovery_stop_1",
      "cmd_recovery_stop_2",
      "cmd_recovery_stop_3",
    ] as const;
    for (const commandId of commandIds) {
      await persistence.recordCommandAccepted({
        commandId,
        command: renameSessionCommand,
        createdAt: now,
      });
    }
    let handlerStarted = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      handlerStarted = resolveStarted;
    });
    let handlerCalls = 0;
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("session.rename", async ({ signal }) => {
      handlerCalls += 1;
      handlerStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const recovery = reconstructed.recoverDurableCommands();
    await started;
    await Promise.all([reconstructed.shutdown(), recovery]);

    expect(handlerCalls).toBe(1);
    await expect(persistence.getCommand(commandIds[0])).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "COMMAND_CANCELLED" }),
    });
    for (const commandId of commandIds.slice(1)) {
      await expect(persistence.getCommand(commandId)).resolves.toMatchObject({
        status: "accepted",
      });
    }
    const resumed: string[] = [];
    const replacement = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    replacement.registerHandler("session.rename", async ({ commandId }) => {
      resumed.push(commandId);
    });

    await replacement.recoverDurableCommands();

    expect(resumed).toEqual(commandIds.slice(1));
    for (const commandId of commandIds.slice(1)) {
      await expect(persistence.getCommand(commandId)).resolves.toMatchObject({
        status: "succeeded",
      });
      await expect(
        persistence.listEvents({ commandId, type: "command.accepted" }),
      ).resolves.toHaveLength(1);
    }
    await replacement.shutdown();
    sqlite.close();
  });

  it("continues accepted recovery in scope after a handler failure", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const commandIds = ["cmd_recovery_failure_1", "cmd_recovery_failure_2"] as const;
    for (const [index, commandId] of commandIds.entries()) {
      await persistence.recordCommandAccepted({
        commandId,
        command: {
          type: "session.rename",
          payload: { sessionId: "ses_recovery_failure", title: `Recovery ${index}` },
        },
        createdAt: now,
      });
    }
    const handlerCalls: string[] = [];
    const reconstructed = createCommandQueue({
      persistence,
      clock: { now: () => new Date(now) },
    });
    reconstructed.registerHandler("session.rename", async ({ commandId }) => {
      handlerCalls.push(commandId);
      if (commandId === commandIds[0]) throw new Error("injected recovery failure");
    });

    await expect(reconstructed.recoverDurableCommands()).resolves.toBeUndefined();

    expect(handlerCalls).toEqual(commandIds);
    await expect(persistence.getCommand(commandIds[0])).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ code: "COMMAND_EXECUTION_FAILED" }),
    });
    await expect(persistence.getCommand(commandIds[1])).resolves.toMatchObject({
      status: "succeeded",
    });
    for (const commandId of commandIds) {
      await expect(persistence.listEvents({ commandId })).resolves.toHaveLength(3);
    }
    sqlite.close();
  });

  it("rejects an operation identity replayed with different command input", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    queue.registerHandler("observer.reconcile", async ({ commandId }) => {
      handled.push(commandId);
    });
    queue.registerHandler("session.rename", async ({ commandId }) => {
      handled.push(commandId);
    });

    const first = await queue.dispatch(reconcileCommand, {
      operationId: "req_conflicting_replay",
    });
    await queue.drain();
    const conflict = await queue.dispatch(renameSessionCommand, {
      operationId: "req_conflicting_replay",
    });
    await queue.drain();

    expect(conflict).toMatchObject({
      commandId: first.commandId,
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandValidationError",
        code: "COMMAND_OPERATION_CONFLICT",
      },
    });
    expect(handled).toEqual([first.commandId]);
    expect(await persistence.listCommands()).toHaveLength(1);
    sqlite.close();
  });

  it("admits concurrent exact operation replays only once", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    queue.registerHandler("observer.reconcile", async ({ commandId }) => {
      handled.push(commandId);
    });

    const [first, replay] = await Promise.all([
      queue.dispatch(reconcileCommand, { operationId: "req_concurrent_replay" }),
      queue.dispatch(reconcileCommand, { operationId: "req_concurrent_replay" }),
    ]);
    await queue.drain();

    expect(replay).toEqual(first);
    expect(handled).toEqual([first.commandId]);
    expect(await persistence.listCommands()).toHaveLength(1);
    sqlite.close();
  });

  it("admits startup recovery and an exact operation replay only once", async () => {
    const { sqlite, persistence } = createPersistenceAndQueue();
    const operationId = "req_startup_recovery_replay";
    const commandId = commandIdForOperation(operationId);
    await persistence.recordCommandAccepted({ commandId, command: reconcileCommand });
    let recoveryEntered = () => undefined;
    const entered = new Promise<void>((resolveEntered) => {
      recoveryEntered = resolveEntered;
    });
    let releaseRecovery = () => undefined;
    const release = new Promise<void>((resolveRelease) => {
      releaseRecovery = resolveRelease;
    });
    let blocked = false;
    const blockedPersistence = {
      ...persistence,
      listEvents: async (filter?: Parameters<typeof persistence.listEvents>[0]) => {
        if (!blocked) {
          blocked = true;
          recoveryEntered();
          await release;
        }
        return persistence.listEvents(filter);
      },
    };
    const handled: string[] = [];
    const reconstructed = createCommandQueue({ persistence: blockedPersistence });
    reconstructed.registerHandler("observer.reconcile", async ({ commandId: handledId }) => {
      handled.push(handledId);
    });

    const recovery = reconstructed.recoverDurableCommands();
    await entered;
    const replay = reconstructed.dispatch(reconcileCommand, { operationId });
    releaseRecovery();
    const [, receipt] = await Promise.all([recovery, replay]);

    expect(receipt.commandId).toBe(commandId);
    expect(handled).toEqual([commandId]);
    expect((await persistence.listEvents({ commandId })).map(({ event }) => event.type)).toEqual([
      "command.accepted",
      "command.started",
      "command.succeeded",
    ]);
    await reconstructed.shutdown();
    sqlite.close();
  });

  it("records accepted, started, and succeeded lifecycle events", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    queue.registerHandler("observer.reconcile", async ({ commandId }) => {
      handled.push(commandId);
    });

    const receipt = await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(receipt).toEqual({
      commandId: "cmd_1",
      traceId: expect.stringMatching(/^trc_/),
      spanId: expect.stringMatching(/^spn_/),
      accepted: true,
      status: "accepted",
    });
    expect(handled).toEqual(["cmd_1"]);
    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "succeeded",
        traceId: receipt.traceId,
        spanId: receipt.spanId,
      }),
    ]);
    const events = await persistence.listEvents({ commandId: "cmd_1" });
    expect(events.map((event) => event.type)).toEqual([
      "command.accepted",
      "command.started",
      "command.succeeded",
    ]);
    expect(events.map((event) => event.traceId)).toEqual([
      receipt.traceId,
      receipt.traceId,
      receipt.traceId,
    ]);
    sqlite.close();
  });

  it("records failed commands with SafeError and internal envelope records", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    queue.registerHandler("observer.reconcile", async () => {
      throw new Error("raw provider stack detail");
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: expect.objectContaining({
          tag: "CommandExecutionError",
          code: "COMMAND_EXECUTION_FAILED",
          commandId: "cmd_1",
        }),
      }),
    ]);
    expect(JSON.stringify((await persistence.listCommands())[0]?.error)).not.toContain(
      "raw provider",
    );
    expect(await persistence.listCommandErrors("cmd_1")).toEqual([
      expect.objectContaining({
        commandId: "cmd_1",
        envelope: expect.objectContaining({
          id: "err_1",
          tag: "CommandExecutionError",
        }),
      }),
    ]);
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    sqlite.close();
  });

  it("preserves SafeError causes through command failure wrappers", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const cause = {
      tag: "ProviderUnavailableError",
      code: "WORKTRUNK_UNAVAILABLE",
      message: "Worktrunk is not available.",
      hint: "Install Worktrunk with brew install worktrunk.",
      provider: "worktrunk",
    };
    queue.registerHandler("observer.reconcile", async () => {
      throw new Error("observer command wrapper", { cause });
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: expect.objectContaining({
          tag: "ProviderUnavailableError",
          code: "WORKTRUNK_UNAVAILABLE",
          provider: "worktrunk",
          commandId: "cmd_1",
        }),
      }),
    ]);
    expect(await persistence.listCommandErrors("cmd_1")).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          tag: "ProviderUnavailableError",
          code: "WORKTRUNK_UNAVAILABLE",
          provider: "worktrunk",
        }),
      }),
    ]);
    sqlite.close();
  });

  it("stores lean command SafeErrors while returning command diagnostics from envelopes", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const diagnostic = {
      type: "external_command",
      provider: "worktrunk",
      operation: "provider.worktrunk.switch",
      command: "wt switch --no-hooks --create feature --no-cd --format=json",
      cwd: "/tmp/station/web",
      exitCode: 2,
      stderrSnippet: "error: unexpected argument '--no-hooks' found",
      durationMs: 42,
    } as const;
    const cause = {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_UNSUPPORTED_FLAG",
      message: "Worktrunk rejected an automation flag used by STATION.",
      provider: "worktrunk",
      diagnosticDetails: [diagnostic],
    };
    queue.registerHandler("observer.reconcile", async () => {
      throw new Error("observer command wrapper", { cause });
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    await expect(persistence.getCommand("cmd_1")).resolves.toMatchObject({
      id: "cmd_1",
      status: "failed",
      error: {
        tag: "WorktreeProviderError",
        code: "WORKTRUNK_UNSUPPORTED_FLAG",
        provider: "worktrunk",
      },
      diagnostics: [diagnostic],
    });
    const command = await persistence.getCommand("cmd_1");
    expect(command?.error).not.toHaveProperty("diagnosticDetails");
    await expect(persistence.listCommandErrors("cmd_1")).resolves.toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          code: "WORKTRUNK_UNSUPPORTED_FLAG",
          diagnostics: [diagnostic],
        }),
      }),
    ]);
    sqlite.close();
  });

  it("fails accepted commands that do not have registered handlers", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();

    const receipts = await Promise.all([queue.dispatch(createWorktreeCommand)]);
    await queue.drain();

    expect(receipts).toEqual([
      expect.objectContaining({ commandId: "cmd_1", accepted: true, status: "accepted" }),
    ]);
    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        traceId: receipts[0]?.traceId,
        error: expect.objectContaining({
          tag: "CommandRoutingError",
          code: "COMMAND_HANDLER_MISSING",
          commandId: "cmd_1",
          traceId: receipts[0]?.traceId,
        }),
      }),
    ]);
    for (const receipt of receipts) {
      const events = await persistence.listEvents({ commandId: receipt.commandId });
      expect(events.map((event) => event.type)).toEqual([
        "command.accepted",
        "command.started",
        "command.failed",
      ]);
      expect(events.map((event) => event.traceId)).toEqual([
        receipt.traceId,
        receipt.traceId,
        receipt.traceId,
      ]);
    }
    sqlite.close();
  });

  it("serializes command execution by session scope", async () => {
    const { sqlite, queue } = createPersistenceAndQueue();
    const starts: string[] = [];
    const finishes: string[] = [];
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.registerHandler("session.rename", async ({ commandId }) => {
      starts.push(commandId);
      if (commandId === "cmd_1") {
        await firstBlocked;
      }
      finishes.push(commandId);
    });

    const first = queue.dispatch(renameSessionCommand);
    const second = queue.dispatch(renameSessionCommand);
    await Promise.all([first, second]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(starts).toEqual(["cmd_1"]);

    releaseFirst();
    await queue.drain();

    expect(starts).toEqual(["cmd_1", "cmd_2"]);
    expect(finishes).toEqual(["cmd_1", "cmd_2"]);
    sqlite.close();
  });

  it("serializes terminal close execution by session scope", async () => {
    const { sqlite, queue } = createPersistenceAndQueue();
    const starts: string[] = [];
    const finishes: string[] = [];
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.registerHandler("terminal.close", async ({ commandId }) => {
      starts.push(commandId);
      if (commandId === "cmd_1") {
        await firstBlocked;
      }
      finishes.push(commandId);
    });

    const first = queue.dispatch(closeTerminalCommand);
    const second = queue.dispatch(closeTerminalCommand);
    await Promise.all([first, second]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(starts).toEqual(["cmd_1"]);

    releaseFirst();
    await queue.drain();

    expect(starts).toEqual(["cmd_1", "cmd_2"]);
    expect(finishes).toEqual(["cmd_1", "cmd_2"]);
    sqlite.close();
  });

  it("serializes Group writes by project while allowing another project to progress", async () => {
    const { sqlite, queue } = createPersistenceAndQueue();
    const starts: string[] = [];
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = async ({ commandId }: { commandId: string }) => {
      starts.push(commandId);
      if (commandId === "cmd_1") await firstBlocked;
    };
    queue.registerHandler("sessionGroup.reparent", handler);
    queue.registerHandler("sessionGroup.create", handler);

    await Promise.all([
      queue.dispatch(reparentSessionGroupCommand),
      queue.dispatch(createSessionGroupCommand),
      queue.dispatch(createApiSessionGroupCommand),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(starts).toEqual(["cmd_1", "cmd_3"]);
    releaseFirst();
    await queue.drain();
    expect(starts).toEqual(["cmd_1", "cmd_3", "cmd_2"]);
    sqlite.close();
  });

  it("times out hung commands and persists a typed failure", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue({ commandTimeoutMs: 5 });
    queue.registerHandler("observer.reconcile", async () => new Promise(() => undefined));

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: expect.objectContaining({
          tag: "TimeoutError",
          code: "COMMAND_TIMEOUT",
          commandId: "cmd_1",
        }),
      }),
    ]);
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    sqlite.close();
  });

  it("waits for a begun durable commit instead of recording a timeout failure", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue({ commandTimeoutMs: 5 });
    queue.registerHandler("observer.reconcile", async ({ beginCommit }) => {
      beginCommit();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    await expect(persistence.getCommand("cmd_1")).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.succeeded"]);
    sqlite.close();
  });

  it("drains a committed external mutation after the command deadline", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue({ commandTimeoutMs: 5 });
    let classificationFinished = false;
    queue.registerHandler("observer.reconcile", async ({ markExternalMutationCommitted }) => {
      markExternalMutationCommitted?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      classificationFinished = true;
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(classificationFinished).toBe(true);
    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({ id: "cmd_1", status: "succeeded" }),
    ]);
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.succeeded"]);
    sqlite.close();
  });

  it("records a committed handler failure after the command deadline", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue({ commandTimeoutMs: 5 });
    queue.registerHandler("observer.reconcile", async ({ markExternalMutationCommitted }) => {
      markExternalMutationCommitted?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("injected committed classification failure");
    });

    await queue.dispatch(reconcileCommand);
    await queue.drain();

    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: expect.objectContaining({ code: "COMMAND_EXECUTION_FAILED" }),
      }),
    ]);
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    sqlite.close();
  });
  it("shutdown interrupts an in-flight command and drains after failure is recorded", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue({ commandTimeoutMs: 1000 });
    let started = () => {};
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    queue.registerHandler(
      "observer.reconcile",
      async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started();
        }),
    );

    await queue.dispatch(reconcileCommand);
    await commandStarted;
    await queue.shutdown();

    expect(await persistence.listCommands()).toEqual([
      expect.objectContaining({
        id: "cmd_1",
        status: "failed",
        error: expect.objectContaining({
          tag: "CancellationError",
          code: "COMMAND_CANCELLED",
          commandId: "cmd_1",
        }),
      }),
    ]);
    expect(
      (await persistence.listEvents({ commandId: "cmd_1" })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    sqlite.close();
  });
});
