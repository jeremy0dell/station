import type { StationCommand, StationEvent } from "@station/contracts";
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

describe("observer command queue", () => {
  it("returns the original durable receipt after queue reconstruction", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    const handler = async ({ commandId }: { commandId: string }) => {
      handled.push(commandId);
    };
    queue.registerHandler("observer.reconcile", handler);

    const first = await queue.dispatch(reconcileCommand, { operationId: "req_lost_response" });
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

  it("recovers a stranded accepted operation exactly once", async () => {
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
    expect(
      (await persistence.listEvents({ commandId: first.commandId })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.succeeded"]);
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
    sqlite.close();
  });

  it("rejects an operation identity reused with different input", async () => {
    const { sqlite, persistence, queue } = createPersistenceAndQueue();
    const handled: string[] = [];
    queue.registerHandler("observer.reconcile", async ({ commandId }) => {
      handled.push(commandId);
    });
    queue.registerHandler("session.rename", async ({ commandId }) => {
      handled.push(commandId);
    });

    const first = await queue.dispatch(reconcileCommand, { operationId: "req_conflict" });
    await queue.drain();
    const conflict = await queue.dispatch(renameSessionCommand, { operationId: "req_conflict" });
    await queue.drain();

    expect(conflict).toMatchObject({
      commandId: first.commandId,
      accepted: false,
      status: "rejected",
      error: { code: "COMMAND_OPERATION_CONFLICT" },
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
      queue.dispatch(reconcileCommand, { operationId: "req_concurrent" }),
      queue.dispatch(reconcileCommand, { operationId: "req_concurrent" }),
    ]);
    await queue.drain();

    expect(replay).toEqual(first);
    expect(handled).toEqual([first.commandId]);
    expect(await persistence.listCommands()).toHaveLength(1);
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
