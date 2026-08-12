import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CommandDispatchOptions,
  CommandId,
  CommandReceipt,
  StationCommand,
  StationEvent,
  TerminalClosePayload,
  TerminalFocusPayload,
  TraceContext,
} from "@station/contracts";
import { CommandReceiptSchema, StationCommandSchema } from "@station/contracts";
import { createTraceContext } from "@station/observability";
import {
  type RuntimeClock,
  runRuntimeBoundary,
  runRuntimeBoundaryWithTimeout,
  systemClock,
} from "@station/runtime";
import { createErrorEnvelope, toSafeError } from "../diagnostics/errors.js";
import type {
  CommandJournal,
  EventJournal,
  ObserverIdFactory,
  PersistedCommand,
} from "../persistence/index.js";
import type { StationLogger } from "../stationLogger.js";
import { nowIso } from "../utils/time.js";
import { commandCancellationError, linkAbortSignals, throwIfAborted } from "./cancellation.js";

export type CommandHandlerContext = {
  commandId: CommandId;
  trace: TraceContext;
  command: StationCommand;
  signal: AbortSignal;
  /** Refuses cancellation before entry, then makes the handler drain to one completion. */
  beginCommit(): void;
  /** Drains authoritative external mutation completion across a later timeout or cancellation. */
  markExternalMutationCommitted?(): void;
};

type CommandExecutionContext = Omit<
  CommandHandlerContext,
  "signal" | "beginCommit" | "markExternalMutationCommitted"
>;

export type CommandHandler = (context: CommandHandlerContext) => Promise<void>;

export type CommandQueue = {
  dispatch(command: StationCommand, options?: CommandDispatchOptions): Promise<CommandReceipt>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
  registerHandler(commandType: StationCommand["type"], handler: CommandHandler): void;
};

export type CreateCommandQueueOptions = {
  persistence: CommandJournal & EventJournal;
  clock?: RuntimeClock;
  idFactory?: Partial<Pick<ObserverIdFactory, "commandId" | "errorId">>;
  handlers?: Partial<Record<StationCommand["type"], CommandHandler>>;
  logger?: StationLogger;
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
  const operationAdmissionChains = new Map<CommandId, Promise<void>>();
  const executingCommandIds = new Set<CommandId>();
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  let shuttingDown = false;

  const scheduleExecution = (
    context: CommandExecutionContext,
    controller = new AbortController(),
  ): void => {
    if (shuttingDown || executingCommandIds.has(context.commandId)) return;
    const scope = commandScope(context.command);
    const previous = scopeChains.get(scope) ?? Promise.resolve();
    const execution = previous.then(() =>
      executeCommand(options.persistence, handlers, clock, idFactory, context, {
        ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        signal: controller.signal,
        commandTimeoutMs,
      }),
    );
    // Keep the per-scope chain non-throwing; failures are persisted and later commands still run.
    const settled = execution.catch(() => undefined);
    scopeChains.set(scope, settled);
    executingCommandIds.add(context.commandId);
    controllers.add(controller);
    pending.add(settled);
    settled.finally(() => {
      executingCommandIds.delete(context.commandId);
      controllers.delete(controller);
      pending.delete(settled);
      if (scopeChains.get(scope) === settled) {
        scopeChains.delete(scope);
      }
    });
  };

  const queue: CommandQueue = {
    dispatch: async (inputCommand, dispatchOptions) => {
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
      const commandId =
        dispatchOptions?.operationId === undefined
          ? idFactory.commandId()
          : commandIdForOperation(dispatchOptions.operationId);
      const admit = async (): Promise<CommandReceipt> => {
        if (dispatchOptions?.operationId !== undefined) {
          const replay = await recordedOperation(options.persistence, commandId, command);
          if (replay !== undefined) {
            if (replay.receipt.accepted) await resumeAcceptedOperation(replay.recorded);
            return replay.receipt;
          }
        }
        const trace = createTraceContext({ operation: `command.${command.type}` });
        const acceptedEvent: StationEvent = {
          type: "command.accepted",
          commandId,
          command,
          traceId: trace.traceId,
          spanId: trace.spanId,
        };
        try {
          await options.persistence.recordCommandAccepted({
            commandId,
            command,
            createdAt: nowIso(clock),
            traceId: trace.traceId,
            spanId: trace.spanId,
          });
        } catch (error) {
          if (dispatchOptions?.operationId !== undefined) {
            const replay = await recordedOperation(options.persistence, commandId, command);
            if (replay !== undefined) {
              if (replay.receipt.accepted) await resumeAcceptedOperation(replay.recorded);
              return replay.receipt;
            }
          }
          throw error;
        }
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
        scheduleExecution({ commandId, trace, command });
        return acceptedReceipt(commandId, trace);
      };
      return dispatchOptions?.operationId === undefined
        ? admit()
        : withOperationAdmission(operationAdmissionChains, commandId, admit);
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

  async function resumeAcceptedOperation(recorded: PersistedCommand): Promise<void> {
    if (recorded.status !== "accepted" || executingCommandIds.has(recorded.id) || shuttingDown) {
      return;
    }
    const trace = traceFromRecordedCommand(recorded);
    const acceptedEvents = await options.persistence.listEvents({
      commandId: recorded.id,
      type: "command.accepted",
    });
    if (acceptedEvents.length === 0) {
      const acceptedEvent: StationEvent = {
        type: "command.accepted",
        commandId: recorded.id,
        command: recorded.command,
        traceId: trace.traceId,
        spanId: trace.spanId,
      };
      await options.persistence.recordEvent(acceptedEvent, {
        commandId: recorded.id,
        traceId: trace.traceId,
        spanId: trace.spanId,
        createdAt: recorded.createdAt,
      });
      options.eventBus?.publish(acceptedEvent);
    }
    const current = await options.persistence.getCommand(recorded.id);
    if (current?.status === "accepted") {
      scheduleExecution({ commandId: current.id, trace, command: current.command });
    }
  }

  return queue;
}

function commandIdForOperation(operationId: string): CommandId {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return `cmd_op_${digest}`;
}

async function recordedOperation(
  persistence: CommandJournal,
  commandId: CommandId,
  command: StationCommand,
): Promise<{ recorded: PersistedCommand; receipt: CommandReceipt } | undefined> {
  const recorded = await persistence.getCommand(commandId);
  if (recorded === undefined) return undefined;
  if (!isDeepStrictEqual(recorded.command, command)) {
    return {
      recorded,
      receipt: CommandReceiptSchema.parse({
        commandId,
        accepted: false,
        status: "rejected",
        error: {
          tag: "CommandValidationError",
          code: "COMMAND_OPERATION_CONFLICT",
          message: "This command operation identity was already used for different input.",
          hint: "Retry only the original command or dispatch a new operation.",
          commandId,
        },
      }),
    };
  }
  return { recorded, receipt: receiptFromRecordedOperation(recorded) };
}

function traceFromRecordedCommand(recorded: PersistedCommand): TraceContext {
  const fallback = createTraceContext({ operation: `command.${recorded.command.type}` });
  return {
    traceId: recorded.traceId ?? fallback.traceId,
    spanId: recorded.spanId ?? fallback.spanId,
    operation: `command.${recorded.command.type}`,
  };
}

async function withOperationAdmission<T>(
  chains: Map<CommandId, Promise<void>>,
  commandId: CommandId,
  task: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(commandId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => turn);
  chains.set(commandId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (chains.get(commandId) === current) chains.delete(commandId);
  }
}

function acceptedReceipt(commandId: CommandId, trace: TraceContext): CommandReceipt {
  return CommandReceiptSchema.parse({
    commandId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    accepted: true,
    status: "accepted",
  });
}

function receiptFromRecordedOperation(recorded: PersistedCommand): CommandReceipt {
  const receipt: CommandReceipt = {
    commandId: recorded.id,
    accepted: true,
    status: "accepted",
  };
  if (recorded.traceId !== undefined) receipt.traceId = recorded.traceId;
  if (recorded.spanId !== undefined) receipt.spanId = recorded.spanId;
  return CommandReceiptSchema.parse(receipt);
}

async function executeCommand(
  persistence: CommandJournal & EventJournal,
  handlers: Map<StationCommand["type"], CommandHandler>,
  clock: RuntimeClock,
  idFactory: Pick<ObserverIdFactory, "errorId">,
  context: CommandExecutionContext,
  runtime?: {
    eventBus?: {
      publish(event: StationEvent): void;
    };
    logger?: StationLogger;
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
  let commitStarted = false;
  let externalMutationCommitted = false;
  let handlerExecution: Promise<void> | undefined;
  let result = await runRuntimeBoundaryWithTimeout(
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
        handlerExecution = handler({
          ...context,
          signal: linked.signal,
          beginCommit: () => {
            throwIfAborted(linked.signal);
            commitStarted = true;
          },
          markExternalMutationCommitted: () => {
            externalMutationCommitted = true;
          },
        });
        await handlerExecution;
        if (!commitStarted && !externalMutationCommitted) throwIfAborted(linked.signal);
      } finally {
        linked.cleanup();
      }
    },
  );

  if (
    !result.ok &&
    (commitStarted || externalMutationCommitted) &&
    handlerExecution !== undefined
  ) {
    const committedExecution = handlerExecution;
    result = await runRuntimeBoundary(
      {
        operation: `command.${context.command.type}.committed`,
        clock,
        error: {
          tag: "CommandExecutionError",
          code: "COMMAND_EXECUTION_FAILED",
          message: "Observer command execution failed.",
          traceId: context.trace.traceId,
        },
        trace: context.trace,
      },
      () => committedExecution,
    );
  }

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
    case "session.rename":
    case "session.acknowledgeTurn":
      return `session:${command.payload.sessionId}`;
    case "worktree.remove":
    case "session.startAgent":
    case "session.resumeAgent":
    case "session.importRecoveryHandle":
      return `worktree:${command.payload.worktreeId}`;
    case "worktree.create":
    case "worktree.fork":
    case "session.create":
    case "session.fork":
    case "sessionGroup.create":
    case "sessionGroup.rename":
    case "sessionGroup.updateMembership":
    case "sessionGroup.reparent":
    case "sessionGroup.delete":
      return `project:${command.payload.projectId}`;
    case "observer.reconcile":
    case "project.add":
    case "project.remove":
    case "project.setDefaultHarness":
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
