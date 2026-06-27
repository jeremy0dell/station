import { randomUUID } from "node:crypto";
import type {
  CommandId,
  CommandReceipt,
  StationCommand,
  StationEvent,
  TerminalClosePayload,
  TerminalFocusPayload,
  TraceContext,
} from "@station/contracts";
import { CommandReceiptSchema, StationCommandSchema } from "@station/contracts";
import { createTraceContext, type JsonlLogger } from "@station/observability";
import { type RuntimeClock, runRuntimeBoundaryWithTimeout, systemClock } from "@station/runtime";
import { createErrorEnvelope, toSafeError } from "../diagnostics/errors.js";
import type { ObserverIdFactory, ObserverPersistence } from "../persistence/index.js";
import { nowIso } from "../utils/time.js";
import { commandCancellationError, linkAbortSignals, throwIfAborted } from "./cancellation.js";

export type CommandHandlerContext = {
  commandId: CommandId;
  trace: TraceContext;
  command: StationCommand;
  signal: AbortSignal;
};

type CommandExecutionContext = Omit<CommandHandlerContext, "signal">;

export type CommandHandler = (context: CommandHandlerContext) => Promise<void>;

export type CommandQueue = {
  dispatch(command: StationCommand): Promise<CommandReceipt>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
  registerHandler(commandType: StationCommand["type"], handler: CommandHandler): void;
};

export type CreateCommandQueueOptions = {
  persistence: ObserverPersistence;
  clock?: RuntimeClock;
  idFactory?: Partial<Pick<ObserverIdFactory, "commandId" | "errorId">>;
  handlers?: Partial<Record<StationCommand["type"], CommandHandler>>;
  logger?: JsonlLogger;
  eventBus?: {
    publish(event: StationEvent): void;
  };
  commandTimeoutMs?: number;
};

const defaultCommandId = () => `cmd_${randomUUID()}`;
const defaultErrorId = () => `err_${randomUUID()}`;

export function createCommandQueue(options: CreateCommandQueueOptions): CommandQueue {
  const clock = options.clock ?? systemClock;
  const idFactory = {
    commandId: defaultCommandId,
    errorId: defaultErrorId,
    ...options.idFactory,
  };
  const handlers = new Map<StationCommand["type"], CommandHandler>(
    Object.entries(options.handlers ?? {}) as [StationCommand["type"], CommandHandler][],
  );
  // Commands serialize by the narrowest stable identity we can infer; unrelated scopes run in parallel.
  const scopeChains = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  let shuttingDown = false;

  const queue: CommandQueue = {
    dispatch: async (inputCommand) => {
      const command = StationCommandSchema.parse(inputCommand);
      if (shuttingDown) {
        const receipt: CommandReceipt = {
          commandId: idFactory.commandId(),
          accepted: false,
          status: "rejected",
          error: {
            tag: "CancellationError",
            code: "COMMAND_QUEUE_SHUTTING_DOWN",
            message: "Observer command queue is shutting down.",
          },
        };
        return CommandReceiptSchema.parse(receipt);
      }
      const commandId = idFactory.commandId();
      const trace = createTraceContext({ operation: `command.${command.type}` });
      const controller = new AbortController();
      const acceptedEvent: StationEvent = {
        type: "command.accepted",
        commandId,
        command,
        traceId: trace.traceId,
        spanId: trace.spanId,
      };
      await options.persistence.recordCommandAccepted({
        commandId,
        command,
        createdAt: nowIso(clock),
        traceId: trace.traceId,
        spanId: trace.spanId,
      });
      await options.persistence.recordEvent(acceptedEvent, {
        commandId,
        traceId: trace.traceId,
        spanId: trace.spanId,
        createdAt: nowIso(clock),
      });
      await options.logger?.info("Command accepted.", {
        commandId,
        commandType: command.type,
        traceId: trace.traceId,
        spanId: trace.spanId,
      });
      options.eventBus?.publish(acceptedEvent);

      const scope = commandScope(command);
      const previous = scopeChains.get(scope) ?? Promise.resolve();
      const execution = previous.then(() =>
        executeCommand(
          options.persistence,
          handlers,
          clock,
          idFactory,
          {
            commandId,
            trace,
            command,
          },
          {
            ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            signal: controller.signal,
            commandTimeoutMs,
          },
        ),
      );
      // Keep the per-scope chain non-throwing; failures are persisted and later commands still run.
      const settled = execution.catch(() => undefined);
      scopeChains.set(scope, settled);
      controllers.add(controller);
      pending.add(settled);
      settled.finally(() => {
        controllers.delete(controller);
        pending.delete(settled);
        if (scopeChains.get(scope) === settled) {
          scopeChains.delete(scope);
        }
      });

      const receipt: CommandReceipt = {
        commandId,
        traceId: trace.traceId,
        spanId: trace.spanId,
        accepted: true,
        status: "accepted",
      };
      return CommandReceiptSchema.parse(receipt);
    },

    drain: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },

    shutdown: async () => {
      shuttingDown = true;
      for (const controller of controllers) {
        controller.abort(commandCancellationError());
      }
      await queue.drain();
    },

    registerHandler: (commandType, handler) => {
      handlers.set(commandType, handler);
    },
  };

  return queue;
}

async function executeCommand(
  persistence: ObserverPersistence,
  handlers: Map<StationCommand["type"], CommandHandler>,
  clock: RuntimeClock,
  idFactory: Pick<ObserverIdFactory, "errorId">,
  context: CommandExecutionContext,
  runtime?: {
    eventBus?: {
      publish(event: StationEvent): void;
    };
    logger?: JsonlLogger;
    signal?: AbortSignal;
    commandTimeoutMs?: number;
  },
): Promise<void> {
  await persistence.markCommandStarted(context.commandId, nowIso(clock));
  const startedEvent: StationEvent = {
    type: "command.started",
    commandId: context.commandId,
    command: context.command,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
  };
  await persistence.recordEvent(startedEvent, {
    commandId: context.commandId,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
    createdAt: nowIso(clock),
  });
  await runtime?.logger?.info("Command started.", {
    commandId: context.commandId,
    commandType: context.command.type,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
  });
  runtime?.eventBus?.publish(startedEvent);

  const handler = handlers.get(context.command.type);
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: `command.${context.command.type}`,
      clock,
      timeoutMs: runtime?.commandTimeoutMs ?? 30_000,
      error: {
        tag: "CommandExecutionError",
        code: "COMMAND_EXECUTION_FAILED",
        message: "Observer command execution failed.",
        traceId: context.trace.traceId,
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "COMMAND_TIMEOUT",
        message: "Observer command execution timed out.",
        traceId: context.trace.traceId,
      },
      trace: context.trace,
    },
    async ({ signal }) => {
      // Combine runtime timeout and queue shutdown into the signal handlers receive.
      const linked = linkAbortSignals(signal, runtime?.signal);
      try {
        // Check before and after handler work because provider calls may notice abort cooperatively.
        throwIfAborted(linked.signal);
        if (handler === undefined) {
          throw missingCommandHandlerError();
        }
        await handler({ ...context, signal: linked.signal });
        throwIfAborted(linked.signal);
      } finally {
        linked.cleanup();
      }
    },
  );

  if (result.ok) {
    await persistence.markCommandSucceeded(context.commandId, nowIso(clock));
    const succeededEvent: StationEvent = {
      type: "command.succeeded",
      commandId: context.commandId,
      traceId: context.trace.traceId,
      spanId: context.trace.spanId,
    };
    await persistence.recordEvent(succeededEvent, {
      commandId: context.commandId,
      traceId: context.trace.traceId,
      spanId: context.trace.spanId,
      createdAt: nowIso(clock),
    });
    await runtime?.logger?.info("Command succeeded.", {
      commandId: context.commandId,
      commandType: context.command.type,
      traceId: context.trace.traceId,
      spanId: context.trace.spanId,
    });
    runtime?.eventBus?.publish(succeededEvent);
    return;
  }

  const safeError = toSafeError(
    result.error,
    {
      tag: "CommandExecutionError",
      code: "COMMAND_EXECUTION_FAILED",
      message: "Observer command execution failed.",
    },
    { commandId: context.commandId, traceId: context.trace.traceId },
  );
  const envelope = createErrorEnvelope({
    id: idFactory.errorId(),
    error: result.error,
    fallback: {
      tag: "CommandExecutionError",
      code: "COMMAND_EXECUTION_FAILED",
      message: "Observer command execution failed.",
    },
    commandId: context.commandId,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
    createdAt: nowIso(clock),
  });
  await persistence.markCommandFailed({
    commandId: context.commandId,
    safeError,
    envelope,
    finishedAt: nowIso(clock),
  });
  const failedEvent: StationEvent = {
    type: "command.failed",
    commandId: context.commandId,
    error: safeError,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
  };
  await persistence.recordEvent(failedEvent, {
    commandId: context.commandId,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
    createdAt: nowIso(clock),
  });
  await runtime?.logger?.error("Command failed.", {
    commandId: context.commandId,
    commandType: context.command.type,
    traceId: context.trace.traceId,
    spanId: context.trace.spanId,
    error: safeError,
  });
  runtime?.eventBus?.publish(failedEvent);
}

function missingCommandHandlerError() {
  return {
    tag: "CommandRoutingError",
    code: "COMMAND_HANDLER_MISSING",
    message: "Observer does not have a handler for this command.",
    hint: "Upgrade station or avoid this command until the command is implemented.",
  };
}

// Prefer the narrowest scope so commands touching the same session, worktree, or project serialize.
function commandScope(command: StationCommand): string {
  switch (command.type) {
    case "terminal.focus":
    case "terminal.close":
      return terminalCommandScope(command.payload);
    case "session.close":
    case "session.sendPrompt":
    case "session.rename":
    case "session.acknowledgeTurn":
      return `session:${command.payload.sessionId}`;
    case "worktree.remove":
    case "session.startAgent":
    case "session.resumeAgent":
      return `worktree:${command.payload.worktreeId}`;
    case "worktree.create":
    case "session.create":
      return `project:${command.payload.projectId}`;
    case "observer.reconcile":
    case "project.add":
    case "project.remove":
    case "project.setDefaultHarness":
    case "hooks.install":
      return "global";
  }
  const _exhaustive: never = command;
  return _exhaustive;
}

function terminalCommandScope(payload: TerminalFocusPayload | TerminalClosePayload): string {
  if (payload.sessionId !== undefined) {
    return `session:${payload.sessionId}`;
  }
  if (payload.worktreeId !== undefined) {
    return `worktree:${payload.worktreeId}`;
  }
  return "global";
}
