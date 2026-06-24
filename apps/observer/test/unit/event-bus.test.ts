import type { StationEvent } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createObserverEventBus } from "../../src/internal";

describe("observer event bus", () => {
  it("streams matching events and cleans up subscribers", async () => {
    const bus = createObserverEventBus();
    const iterator = bus
      .subscribe({ type: ["command.accepted", "providerHook.ingested"] })
      [Symbol.asyncIterator]();
    const commandEvent: StationEvent = {
      type: "command.accepted",
      commandId: "cmd_1",
      command: { type: "observer.reconcile", payload: { reason: "event-bus-test" } },
    };
    const ignoredEvent: StationEvent = {
      type: "observer.reconciled",
      at: "2026-05-20T12:00:00.000Z",
      changed: 0,
    };
    const hookEvent: StationEvent = {
      type: "providerHook.ingested",
      at: "2026-05-20T12:00:01.000Z",
      hookId: "hook_1",
      provider: "worktrunk",
      event: "worktree.created",
    };

    const first = iterator.next();
    bus.publish(ignoredEvent);
    bus.publish(commandEvent);
    await expect(first).resolves.toEqual({ done: false, value: commandEvent });

    const second = iterator.next();
    bus.publish(hookEvent);

    await expect(second).resolves.toEqual({ done: false, value: hookEvent });
    await iterator.return?.();
  });

  it("filters traced subscriptions by trace id", async () => {
    const bus = createObserverEventBus();
    const iterator = bus.subscribe({ traceId: "trc_match" })[Symbol.asyncIterator]();
    const matchingEvent: StationEvent = {
      type: "command.started",
      commandId: "cmd_1",
      command: { type: "observer.reconcile", payload: { reason: "trace-match" } },
      traceId: "trc_match",
    };
    const differentTraceEvent: StationEvent = {
      type: "command.started",
      commandId: "cmd_2",
      command: { type: "observer.reconcile", payload: { reason: "trace-miss" } },
      traceId: "trc_other",
    };
    const untracedEvent: StationEvent = {
      type: "observer.reconciled",
      at: "2026-05-20T12:00:00.000Z",
      changed: 0,
    };

    const next = iterator.next();
    bus.publish(differentTraceEvent);
    bus.publish(untracedEvent);
    bus.publish(matchingEvent);

    await expect(next).resolves.toEqual({ done: false, value: matchingEvent });
    await iterator.return?.();
  });

  it("composes type and trace filters", async () => {
    const bus = createObserverEventBus();
    const iterator = bus
      .subscribe({ type: "command.failed", traceId: "trc_match" })
      [Symbol.asyncIterator]();
    const wrongTypeEvent: StationEvent = {
      type: "command.started",
      commandId: "cmd_1",
      command: { type: "observer.reconcile", payload: { reason: "wrong-type" } },
      traceId: "trc_match",
    };
    const matchingEvent: StationEvent = {
      type: "command.failed",
      commandId: "cmd_1",
      error: {
        tag: "CommandExecutionError",
        code: "COMMAND_EXECUTION_FAILED",
        message: "Command failed.",
      },
      traceId: "trc_match",
    };

    const next = iterator.next();
    bus.publish(wrongTypeEvent);
    bus.publish(matchingEvent);

    await expect(next).resolves.toEqual({ done: false, value: matchingEvent });
    await iterator.return?.();
  });
});
