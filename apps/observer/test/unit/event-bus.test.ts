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

  it("filters Session Group convergence by command id", async () => {
    const bus = createObserverEventBus();
    const iterator = bus.subscribe({ commandId: "cmd_match" })[Symbol.asyncIterator]();
    const group = {
      id: "grp_active",
      projectId: "web",
      name: "Active",
      sessionIds: [],
      version: 1,
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    };
    const matchingEvent: StationEvent = {
      type: "sessionGroup.updated",
      at: "2026-05-20T12:00:00.000Z",
      commandId: "cmd_match",
      group,
    };

    const next = iterator.next();
    bus.publish({ ...matchingEvent, commandId: "cmd_other" });
    bus.publish(matchingEvent);

    await expect(next).resolves.toEqual({ done: false, value: matchingEvent });
    await iterator.return?.();
  });

  it("preserves order through the subscriber capacity and releases returned queues", async () => {
    const bus = createObserverEventBus({ subscriberCapacity: 2 });
    const iterator = bus.subscribe()[Symbol.asyncIterator]();
    const first = failedEvent(1);
    const second = failedEvent(2);

    bus.publish(first);
    bus.publish(second);

    expect(bus.health()).toEqual({
      activeSubscribers: 1,
      queuedEvents: 2,
      subscriberCapacity: 2,
      highWaterQueuedEvents: 2,
      overflowCount: 0,
      disconnectCount: 0,
      resyncRequiredCount: 0,
    });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: first });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: second });
    expect(bus.health()).toMatchObject({ queuedEvents: 0, highWaterQueuedEvents: 2 });

    await iterator.return?.();
    expect(bus.health()).toMatchObject({ activeSubscribers: 0, queuedEvents: 0 });
  });

  it("disconnects only a lagging subscriber while a healthy subscriber stays responsive", async () => {
    const bus = createObserverEventBus({ subscriberCapacity: 2 });
    const stalled = bus.subscribe()[Symbol.asyncIterator]();
    const healthy = bus.subscribe()[Symbol.asyncIterator]();

    for (const sequence of [1, 2, 3]) {
      const next = healthy.next();
      const event = failedEvent(sequence);
      bus.publish(event);
      await expect(next).resolves.toEqual({ done: false, value: event });
    }

    expect(bus.health()).toEqual({
      activeSubscribers: 1,
      queuedEvents: 0,
      subscriberCapacity: 2,
      highWaterQueuedEvents: 2,
      overflowCount: 1,
      disconnectCount: 1,
      resyncRequiredCount: 1,
      lastOverflowReason: "subscriber-capacity",
    });
    await expect(stalled.next()).resolves.toEqual({ done: true, value: undefined });

    const next = healthy.next();
    const event = failedEvent(4);
    bus.publish(event);
    await expect(next).resolves.toEqual({ done: false, value: event });
    await healthy.return?.();

    expect(bus.health()).toMatchObject({
      activeSubscribers: 0,
      queuedEvents: 0,
      overflowCount: 1,
      disconnectCount: 1,
      resyncRequiredCount: 1,
    });
  });
});

function failedEvent(sequence: number): StationEvent {
  return {
    type: "command.failed",
    commandId: `cmd_${sequence}`,
    error: {
      tag: "EventBusTestError",
      code: "EVENT_BUS_TEST",
      message: `Event bus test ${sequence}.`,
    },
  };
}
