import { createObserverService } from "@station/client";
import { type CommandId, type CommandRecord, STATION_SCHEMA_VERSION } from "@station/contracts";
import type { ObserverClient, TerminalCommandRecord } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createCommandSnapshot, fixtureNow } from "../support/snapshots.js";

describe("observer service user-facing copy", () => {
  it("uses generic client copy when no app label is provided", async () => {
    const service = createObserverService({
      client: fakeClient({
        getSnapshot: async () => {
          throw new Error("raw snapshot failure");
        },
      }),
    });

    await expect(service.loadSnapshot()).rejects.toMatchObject({
      code: "CLIENT_SNAPSHOT_FAILED",
      message: "The client could not load the observer snapshot.",
    });
  });

  it("preserves TUI wording when the TUI label is provided", async () => {
    const service = createObserverService({
      clientLabel: "TUI",
      client: fakeClient({
        dispatch: async () => {
          throw new Error("raw dispatch failure");
        },
      }),
    });

    await expect(
      service.dispatch({ type: "observer.reconcile", payload: { reason: "copy-test" } }),
    ).rejects.toMatchObject({
      code: "CLIENT_COMMAND_FAILED",
      message: "The TUI could not dispatch the command.",
    });
  });

  it("labels snapshot timeouts", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      timeoutMs: 1,
      client: fakeClient({
        getSnapshot: async () => never(),
      }),
    });

    await expect(service.loadSnapshot()).rejects.toMatchObject({
      code: "CLIENT_SNAPSHOT_TIMEOUT",
      message: "The Station timed out while loading the observer snapshot.",
    });
  });

  it("labels dispatch timeouts", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      timeoutMs: 1,
      client: fakeClient({
        dispatch: async () => never(),
      }),
    });

    await expect(
      service.dispatch({ type: "observer.reconcile", payload: { reason: "copy-test" } }),
    ).rejects.toMatchObject({
      code: "CLIENT_COMMAND_TIMEOUT",
      message: "The Station timed out while dispatching the command.",
    });
  });

  it("labels command wait failures", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      client: fakeClient({
        waitForCommand: async () => {
          throw new Error("raw wait failure");
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_copy")).rejects.toMatchObject({
      code: "CLIENT_COMMAND_WAIT_FAILED",
      message: "The Station could not observe command completion.",
    });
  });

  it("labels command wait timeouts from protocol wait errors", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      client: fakeClient({
        waitForCommand: async () => {
          throw {
            tag: "TimeoutError",
            code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
            message: "Observer command did not finish before the timeout.",
          };
        },
      }),
    });

    await expect(service.waitForCommandCompletion("cmd_copy")).rejects.toMatchObject({
      code: "CLIENT_COMMAND_WAIT_TIMEOUT",
      message: "The Station timed out while waiting for command completion.",
    });
  });

  it("labels reconcile failures", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      client: fakeClient({
        reconcile: async () => {
          throw new Error("raw reconcile failure");
        },
      }),
    });

    await expect(service.reconcile("copy-test")).rejects.toMatchObject({
      code: "CLIENT_RECONCILE_FAILED",
      message: "The Station could not request observer reconciliation.",
    });
  });

  it("labels reconcile timeouts", async () => {
    const service = createObserverService({
      clientLabel: "Station",
      reconcileTimeoutMs: 1,
      client: fakeClient({
        reconcile: async () => never(),
      }),
    });

    await expect(service.reconcile("copy-test")).rejects.toMatchObject({
      code: "CLIENT_RECONCILE_TIMEOUT",
      message: "The Station timed out while reconciling observer state.",
    });
  });
});

function fakeClient(overrides: Partial<ObserverClient>): ObserverClient {
  return {
    getSnapshot: async () => createCommandSnapshot("idle"),
    dispatch: async () => ({ commandId: "cmd_1", accepted: true, status: "accepted" }),
    waitForCommand: async (commandId) =>
      commandRecord(commandId, "succeeded") as TerminalCommandRecord,
    reconcile: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      reason: "copy-test",
      reconciledAt: fixtureNow,
      snapshot: createCommandSnapshot("idle"),
    }),
    subscribe: () => stream([]),
    ...overrides,
  } as ObserverClient;
}

function commandRecord(commandId: CommandId, status: CommandRecord["status"]): CommandRecord {
  return {
    id: commandId,
    type: "terminal.focus",
    command: {
      type: "terminal.focus",
      payload: {
        sessionId: "ses_copy",
      },
    },
    status,
    createdAt: fixtureNow,
  };
}

async function* stream<T>(values: T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
