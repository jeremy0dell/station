import type {
  CommandId,
  CommandRecord,
  EventFilter,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import {
  createObserverClient,
  startProtocolServer,
  type TerminalCommandRecord,
} from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempSocketPath } from "../../../../tests/support/sockets";
import {
  createFakeObserverApi,
  ids,
  protocolTestNow,
  stream,
  waitFor,
} from "../support/fixtures.js";

describe("protocol command wait client", () => {
  it("returns an already terminal command record and closes the subscription", async () => {
    const { socketPath } = await createTempSocketPath();
    let returned = false;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        getCommand: async (commandId) => commandRecord(commandId, "succeeded"),
        subscribe: () =>
          cleanupStream(() => {
            returned = true;
          }),
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("already") });

    try {
      await expect(client.waitForCommand("cmd_done", { timeoutMs: 500 })).resolves.toMatchObject({
        id: "cmd_done",
        status: "succeeded",
      });
      await waitFor(() => returned);
    } finally {
      await server.close();
    }
  });

  it("subscribes before checking the command record so fast completions are not missed", async () => {
    const { socketPath } = await createTempSocketPath();
    const order: string[] = [];
    let getCount = 0;
    let observedFilter: EventFilter | undefined;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        getCommand: async (commandId) => {
          order.push(`get:${commandId}`);
          getCount += 1;
          return commandRecord(commandId, getCount === 1 ? "started" : "succeeded");
        },
        subscribe: (filter) => {
          order.push("subscribe");
          observedFilter = filter;
          return stream([
            {
              type: "command.succeeded",
              commandId: "cmd_fast",
              traceId: "trc_fast",
            },
          ]);
        },
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("fast") });

    try {
      await expect(client.waitForCommand("cmd_fast", { timeoutMs: 500 })).resolves.toMatchObject({
        id: "cmd_fast",
        status: "succeeded",
      });
      expect(order).toEqual(["subscribe", "get:cmd_fast", "get:cmd_fast"]);
      expect(observedFilter).toEqual({
        type: ["command.succeeded", "command.failed"],
        commandId: "cmd_fast",
      });
    } finally {
      await server.close();
    }
  });

  it("returns failed terminal records with their error payload", async () => {
    const { socketPath } = await createTempSocketPath();
    let getCount = 0;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        getCommand: async (commandId) => {
          getCount += 1;
          return commandRecord(commandId, getCount === 1 ? "started" : "failed");
        },
        subscribe: () =>
          stream([
            {
              type: "command.failed",
              commandId: "cmd_failed",
              error: commandError(),
              traceId: "trc_failed",
            },
          ]),
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("failed") });

    try {
      await expect(client.waitForCommand("cmd_failed", { timeoutMs: 500 })).resolves.toMatchObject({
        id: "cmd_failed",
        status: "failed",
        error: {
          code: "COMMAND_EXECUTION_FAILED",
          diagnosticId: "diag_command_failed",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("rechecks the command record once when the event stream closes", async () => {
    const { socketPath } = await createTempSocketPath();
    let getCount = 0;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        getCommand: async (commandId) => {
          getCount += 1;
          return commandRecord(commandId, getCount === 1 ? "started" : "succeeded");
        },
        subscribe: () => stream([]),
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("closed") });

    try {
      await expect(client.waitForCommand("cmd_closed", { timeoutMs: 500 })).resolves.toMatchObject({
        id: "cmd_closed",
        status: "succeeded",
      });
      expect(getCount).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("times out command waits and closes the subscription", async () => {
    const { socketPath } = await createTempSocketPath();
    let returned = false;
    const server = await startProtocolServer({
      socketPath,
      api: createFakeObserverApi({
        getCommand: async (commandId) => commandRecord(commandId, "started"),
        subscribe: () =>
          cleanupStream(() => {
            returned = true;
          }),
      }),
    });
    const client = createObserverClient({ socketPath, requestId: ids("timeout") });

    try {
      await expect(client.waitForCommand("cmd_hung", { timeoutMs: 10 })).rejects.toMatchObject({
        tag: "TimeoutError",
        code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
      });
      await waitFor(() => returned);
    } finally {
      await server.close();
    }
  });
});

function cleanupStream(onReturn: () => void): AsyncIterable<StationEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => new Promise<IteratorResult<StationEvent>>(() => undefined),
      return: async () => {
        onReturn();
        return { done: true, value: undefined };
      },
    }),
  };
}

function commandRecord(commandId: CommandId, status: CommandRecord["status"]): CommandRecord {
  const command = reconcileCommand("protocol-command-wait");
  const record: CommandRecord = {
    id: commandId,
    type: command.type,
    command,
    status,
    createdAt: protocolTestNow,
    traceId: "trc_command_wait",
    spanId: "spn_command_wait",
  };
  if (status === "started" || status === "succeeded" || status === "failed") {
    record.startedAt = protocolTestNow;
  }
  if (status === "succeeded" || status === "failed") {
    record.finishedAt = protocolTestNow;
  }
  if (status === "failed") {
    record.error = commandError();
  }
  return record;
}

function reconcileCommand(reason: string): StationCommand {
  return {
    type: "observer.reconcile",
    payload: { reason },
  };
}

function commandError(): NonNullable<TerminalCommandRecord["error"]> {
  return {
    tag: "CommandExecutionError",
    code: "COMMAND_EXECUTION_FAILED",
    message: "Observer command execution failed.",
    diagnosticId: "diag_command_failed",
  };
}
