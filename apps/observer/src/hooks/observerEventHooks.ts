import type { ObserverEventHookConfig, StationEvent } from "@station/contracts";
import {
  ObserverEventHookInvocationSchema,
  STATION_SCHEMA_VERSION,
  stationEventMetadata,
} from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandRunner,
  type RuntimeClock,
  runExternalCommand,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import type { StationLogger } from "../stationLogger.js";

export type ObserverEventHookRuntime = {
  shutdown(): Promise<void>;
};

export type CreateObserverEventHookRuntimeOptions = {
  hooks: ObserverEventHookConfig[];
  eventBus: ObserverEventBus;
  clock?: RuntimeClock;
  logger?: StationLogger;
  commandRunner?: ExternalCommandRunner;
};

type ObserverEventHookDispatchInput = {
  event: StationEvent;
  hooks: ObserverEventHookConfig[];
  clock: RuntimeClock;
  logger?: StationLogger;
  commandRunner?: ExternalCommandRunner;
};

const defaultTimeoutMs = 3000;

function dispatchObserverEventHooks(input: ObserverEventHookDispatchInput): void {
  for (const hook of input.hooks) {
    if (!observerEventHookMatches(hook, input.event)) {
      continue;
    }
    void runObserverEventHook({ ...input, hook }).catch(async (error) => {
      await input.logger?.error("Event hook failed.", {
        hookId: hook.id,
        eventType: input.event.type,
        error: safeErrorFromUnknown(error, {
          tag: "EventHookError",
          code: "EVENT_HOOK_FAILED",
          message: "Observer event hook command failed.",
        }),
      });
    });
  }
}

async function runObserverEventHook(input: {
  event: StationEvent;
  hook: ObserverEventHookConfig;
  clock: RuntimeClock;
  logger?: StationLogger;
  commandRunner?: ExternalCommandRunner;
}): Promise<void> {
  const invocation = ObserverEventHookInvocationSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: input.hook.id,
    observedAt: observedAtForEvent(input.event, input.clock),
    event: input.event,
  });
  const command: ExternalCommandInput = {
    command: input.hook.command,
    args: input.hook.args ?? [],
    timeoutMs: input.hook.timeoutMs ?? defaultTimeoutMs,
    stdin: `${JSON.stringify(invocation)}\n`,
  };
  if (input.commandRunner === undefined) {
    await runExternalCommand(command);
  } else {
    await runExternalCommand(command, input.commandRunner);
  }
  await input.logger?.info("Event hook completed.", {
    hookId: input.hook.id,
    eventType: input.event.type,
  });
}

function observedAtForEvent(event: StationEvent, clock: RuntimeClock): string {
  const metadata = stationEventMetadata(event);
  if (metadata.timestamp !== undefined) {
    return metadata.timestamp;
  }
  if (event.type === "worktree.agentStateChanged" && event.agent?.updatedAt !== undefined) {
    return event.agent.updatedAt;
  }
  if (event.type === "session.updated" && event.patch.updatedAt !== undefined) {
    return event.patch.updatedAt;
  }
  return toIsoTimestamp(clock.now());
}

export function createObserverEventHookRuntime(
  options: CreateObserverEventHookRuntimeOptions,
): ObserverEventHookRuntime {
  const hooks = options.hooks;
  const clock = options.clock ?? systemClock;
  const subscription = options.eventBus.subscribe();
  const iterator = subscription[Symbol.asyncIterator]();
  let active = true;

  void (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true || !active) {
          return;
        }
        const dispatchInput: ObserverEventHookDispatchInput = {
          event: next.value,
          hooks,
          clock,
        };
        if (options.logger !== undefined) dispatchInput.logger = options.logger;
        if (options.commandRunner !== undefined)
          dispatchInput.commandRunner = options.commandRunner;
        dispatchObserverEventHooks(dispatchInput);
      }
    } catch (error) {
      await options.logger?.error("Event hook runtime stopped unexpectedly.", {
        error: safeErrorFromUnknown(error, {
          tag: "EventHookError",
          code: "EVENT_HOOK_RUNTIME_FAILED",
          message: "Observer event hook runtime stopped unexpectedly.",
        }),
      });
    }
  })();

  return {
    shutdown: async () => {
      active = false;
      await iterator.return?.();
    },
  };
}

export function observerEventHookMatches(
  hook: ObserverEventHookConfig,
  event: StationEvent,
): boolean {
  if (!hook.events.includes(event.type)) {
    return false;
  }
  if (hook.filter === undefined) {
    return true;
  }
  if (hook.filter.agentState !== undefined) {
    if (
      event.type !== "worktree.agentStateChanged" ||
      event.agent?.state !== hook.filter.agentState
    ) {
      return false;
    }
  }
  if (hook.filter.harness !== undefined) {
    if (
      event.type !== "worktree.agentStateChanged" ||
      event.agent?.harness !== hook.filter.harness
    ) {
      return false;
    }
  }
  if (hook.filter.changeSource !== undefined) {
    if (
      event.type !== "worktree.agentStateChanged" ||
      event.changeSource !== hook.filter.changeSource
    ) {
      return false;
    }
  }
  if (hook.filter.harnessEventType !== undefined) {
    if (
      event.type !== "worktree.agentStateChanged" ||
      event.harnessEventType !== hook.filter.harnessEventType
    ) {
      return false;
    }
  }
  return true;
}
