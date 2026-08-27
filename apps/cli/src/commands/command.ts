import { isDeepStrictEqual } from "node:util";
import type { StationConfig } from "@station/config";
import type {
  AcceptedCommandReceipt,
  CommandExecutionOutcome,
  CommandId,
  CommandReceipt,
  CommandRecord,
  FailedCommandRecord,
  ObserverApi,
  RejectedCommandReceipt,
  SafeError,
  StationCommand,
  SucceededCommandRecord,
} from "@station/contracts";
import { CommandIdSchema, StationCommandSchema } from "@station/contracts";
import { createObserverClient, type ObserverClient } from "@station/protocol";
import { isSafeError, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { CliInputError, parsePositiveIntegerOption } from "../args.js";
import type { CliRunCorrelation } from "../cliTypes.js";
import {
  assertObserverRunning,
  type ObserverProcessDeps,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type CommandCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  stdin?: string;
  timeoutMs?: number;
};

export type TypedObserverCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  timeoutMs?: number;
  waitForCompletion?: boolean;
};

export type CommandDispatchReceiptResult =
  | {
      status: "accepted";
      receipt: AcceptedCommandReceipt;
    }
  | {
      status: "rejected";
      receipt: RejectedCommandReceipt;
    };

export type CommandDispatchCompletedResult =
  | {
      status: "succeeded";
      receipt: AcceptedCommandReceipt;
      command: SucceededCommandRecord;
    }
  | {
      status: "failed";
      receipt: AcceptedCommandReceipt;
      command: FailedCommandRecord;
    };

export type CommandGetResult = {
  command: CommandRecord;
};

export type CommandCommandResult =
  | CommandDispatchReceiptResult
  | CommandDispatchCompletedResult
  | CommandGetResult;

type ParsedCommandArgs =
  | {
      action: "dispatch";
      wait: boolean;
      stdin: boolean;
      timeoutMs?: number;
    }
  | {
      action: "get";
      commandId: CommandId;
      timeoutMs?: number;
    };

/**
 * ADAPTER
 *
 * Starts or selects the pinned Observer, dispatches one typed Station command, and optionally
 * reloads its durable terminal outcome through the race-safe protocol completion wait.
 * Post-dispatch waits preserve receipt command/trace correlation, including timeouts, and reject
 * conflicting terminal completion evidence.
 */
export async function executeTypedObserverCommand<TCommand extends StationCommand>(
  command: TCommand,
  options: TypedObserverCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<CommandExecutionOutcome<TCommand>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const client = await createCommandObserverClient(options, timeoutMs, deps);
  const receipt = await dispatchCommand(client, command, timeoutMs);
  if (!receipt.accepted) {
    return {
      status: "rejected",
      receipt,
    };
  }
  if (options.waitForCompletion !== true) {
    return {
      status: "accepted",
      receipt,
    };
  }

  let record: CommandRecord;
  try {
    record = await waitForCommand(client, receipt.commandId, timeoutMs);
    if (record.status !== "succeeded" && record.status !== "failed") {
      throw commandWaitTimeoutError();
    }
    assertMatchingCommandCompletion(command, receipt, record);
  } catch (error) {
    throw correlatedCommandWaitError(error, receipt);
  }
  if (record.status === "succeeded") {
    return {
      status: "succeeded",
      receipt,
      record,
    };
  }
  return {
    status: "failed",
    receipt,
    record,
  };
}

/**
 * ADAPTER
 *
 * Parses raw CLI input once, executes typed Observer commands or record lookup, and projects only
 * typed command receipt/record correlation for the process boundary.
 */
export async function runCommandCommand(
  args: string[],
  options: CommandCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<CommandCommandResult> {
  const parsed = parseCommandArgs(args);
  const timeoutMs = parsed.timeoutMs ?? options.timeoutMs ?? 30_000;

  if (parsed.action === "get") {
    const client = await createCommandObserverClient(options, timeoutMs, deps);
    return getCommand(client, parsed.commandId);
  }

  const command = parseCommandFromStdin(options.stdin, parsed.stdin);
  const executionOptions = typedObserverCommandOptions(options, timeoutMs, parsed.wait);
  const outcome = await executeTypedObserverCommand(command, executionOptions, deps);
  if (outcome.status === "accepted" || outcome.status === "rejected") {
    return outcome;
  }
  return {
    status: outcome.status,
    receipt: outcome.receipt,
    command: outcome.record,
  };
}

export function commandCommandExitCode(result: CommandCommandResult): number {
  if ("receipt" in result && result.receipt.accepted === false) {
    return 1;
  }
  if ("status" in result && result.status === "failed") {
    return 1;
  }
  return 0;
}

export function commandCommandCorrelation(
  result: CommandCommandResult,
): CliRunCorrelation | undefined {
  if (!("receipt" in result)) return undefined;
  switch (result.status) {
    case "accepted":
    case "rejected":
      return commandExecutionCorrelation(result);
    case "succeeded":
      return commandExecutionCorrelation({
        status: "succeeded",
        receipt: result.receipt,
        record: result.command,
      });
    case "failed":
      return commandExecutionCorrelation({
        status: "failed",
        receipt: result.receipt,
        record: result.command,
      });
  }
}

export function commandExecutionCorrelation(outcome: CommandExecutionOutcome): CliRunCorrelation {
  let traceId = outcome.receipt.traceId;
  if (outcome.status === "succeeded" || outcome.status === "failed") {
    assertMatchingCorrelation(outcome.receipt, outcome.record);
    traceId ??= outcome.record.traceId;
  }

  const correlation: CliRunCorrelation = {
    status: outcome.status,
    commandId: outcome.receipt.commandId,
  };
  if (traceId !== undefined) correlation.traceId = traceId;
  return correlation;
}

function assertMatchingCorrelation(receipt: AcceptedCommandReceipt, record: CommandRecord): void {
  if (
    record.id !== receipt.commandId ||
    (record.traceId !== undefined &&
      receipt.traceId !== undefined &&
      record.traceId !== receipt.traceId)
  ) {
    throw commandCompletionMismatchError(receipt);
  }
}

async function getCommand(client: ObserverApi, commandId: CommandId): Promise<CommandGetResult> {
  const command = await client.getCommand(commandId);
  if (command === undefined) {
    throw missingCommandRecordError(commandId);
  }
  return {
    command,
  };
}

async function createCommandObserverClient(
  options: Pick<TypedObserverCommandOptions, "config" | "configPath">,
  timeoutMs: number,
  deps: ObserverProcessDeps,
): Promise<ObserverClient> {
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertObserverRunning(status);
  return (
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({
      socketPath: paths.socketPath,
      timeoutMs,
      ...(status.health.version === undefined
        ? {}
        : { expectedBuildVersion: status.health.version }),
    })
  );
}

function typedObserverCommandOptions(
  options: CommandCommandOptions,
  timeoutMs: number,
  waitForCompletion: boolean,
): TypedObserverCommandOptions {
  const executionOptions: TypedObserverCommandOptions = {
    timeoutMs,
    waitForCompletion,
  };
  if (options.config !== undefined) executionOptions.config = options.config;
  if (options.configPath !== undefined) executionOptions.configPath = options.configPath;
  return executionOptions;
}

function missingCommandRecordError(commandId: CommandId): SafeError {
  return {
    tag: "CommandCliError",
    code: "COMMAND_RECORD_NOT_FOUND",
    message: `No command record found for ${commandId}.`,
    hint: "Use a command id returned by `stn command dispatch --stdin --wait`, `stn observe --json`, or `stn debug trace --latest-failure`.",
    commandId,
  };
}

async function dispatchCommand(
  client: ObserverApi,
  command: StationCommand,
  timeoutMs: number,
): Promise<CommandReceipt> {
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.command.dispatch",
      timeoutMs,
      error: {
        tag: "CommandCliError",
        code: "COMMAND_DISPATCH_FAILED",
        message: "Command dispatch could not contact the observer.",
      },
      timeoutError: {
        tag: "TimeoutError",
        code: "COMMAND_DISPATCH_TIMEOUT",
        message: "Command dispatch timed out while contacting the observer.",
      },
    },
    async () => client.dispatch(command),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function waitForCommand(
  client: ObserverClient,
  commandId: CommandId,
  timeoutMs: number,
): Promise<CommandRecord> {
  const result = await runRuntimeBoundaryWithTimeout(
    {
      operation: "cli.command.wait",
      timeoutMs,
      error: {
        tag: "CommandCliError",
        code: "COMMAND_WAIT_FAILED",
        message: "Command wait could not load the observer command record.",
      },
      timeoutError: commandWaitTimeoutError(),
    },
    async () => client.waitForCommand(commandId, { timeoutMs }).catch(mapCommandWaitError),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function assertMatchingCommandCompletion<TCommand extends StationCommand>(
  command: TCommand,
  receipt: AcceptedCommandReceipt,
  record: CommandRecord,
): asserts record is SucceededCommandRecord<TCommand> | FailedCommandRecord<TCommand> {
  if (
    record.id !== receipt.commandId ||
    record.type !== command.type ||
    record.command.type !== command.type ||
    !isDeepStrictEqual(record.command, command) ||
    (receipt.traceId !== undefined &&
      record.traceId !== undefined &&
      receipt.traceId !== record.traceId)
  ) {
    throw commandCompletionMismatchError(receipt);
  }
}

function commandCompletionMismatchError(
  receipt: Pick<CommandReceipt, "commandId" | "traceId">,
): SafeError {
  const error: SafeError = {
    tag: "CommandCliError",
    code: "COMMAND_COMPLETION_MISMATCH",
    message: "The observer returned completion that did not match the dispatched command.",
    hint: `Inspect the durable record with \`stn command get ${receipt.commandId}\` before retrying.`,
    commandId: receipt.commandId,
  };
  if (receipt.traceId !== undefined) error.traceId = receipt.traceId;
  return error;
}

function commandWaitTimeoutError(): SafeError {
  return {
    tag: "TimeoutError",
    code: "COMMAND_WAIT_TIMEOUT",
    message: "Command did not finish before the timeout.",
  };
}

function correlatedCommandWaitError(error: unknown, receipt: AcceptedCommandReceipt): never {
  if (!isSafeError(error)) throw error;
  if (error.commandId !== undefined && error.commandId !== receipt.commandId) {
    throw commandCompletionMismatchError(receipt);
  }
  if (
    error.traceId !== undefined &&
    receipt.traceId !== undefined &&
    error.traceId !== receipt.traceId
  ) {
    throw commandCompletionMismatchError(receipt);
  }
  const correlated: SafeError = {
    ...error,
    commandId: receipt.commandId,
  };
  if (receipt.traceId !== undefined) {
    correlated.traceId = receipt.traceId;
  }
  throw correlated;
}

function mapCommandWaitError(error: unknown): never {
  if (isSafeError(error) && error.tag === "TimeoutError") {
    throw commandWaitTimeoutError();
  }
  throw error;
}

function parseCommandFromStdin(stdin: string | undefined, requiresStdin: boolean): StationCommand {
  if (requiresStdin && (stdin === undefined || stdin.trim().length === 0)) {
    throw new CliInputError(
      "CLI_COMMAND_STDIN_REQUIRED",
      "command dispatch --stdin requires JSON on stdin.",
    );
  }
  if (stdin === undefined) {
    throw new CliInputError("CLI_COMMAND_STDIN_REQUIRED", "command dispatch requires --stdin.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch (cause) {
    throw new CliInputError("CLI_COMMAND_JSON_INVALID", "Invalid command JSON.", { cause });
  }

  const result = StationCommandSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliInputError("CLI_COMMAND_JSON_INVALID", "Invalid command JSON.", {
      cause: result.error,
    });
  }
  return result.data;
}

function parseCommandArgs(args: string[]): ParsedCommandArgs {
  const action = args[0];
  if (action === "dispatch") {
    return parseDispatchArgs(args.slice(1));
  }
  if (action === "get") {
    return parseGetArgs(args.slice(1));
  }
  throw new Error(`Unknown command action: ${action ?? ""}`);
}

function parseDispatchArgs(args: string[]): Extract<ParsedCommandArgs, { action: "dispatch" }> {
  const parsed: Extract<ParsedCommandArgs, { action: "dispatch" }> = {
    action: "dispatch",
    wait: false,
    stdin: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdin") {
      parsed.stdin = true;
      continue;
    }
    if (arg === "--wait") {
      parsed.wait = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const timeoutMs = parseTimeoutMs(args[index + 1], "--timeout-ms");
      parsed.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }
    throw new Error(`Unknown command dispatch option: ${arg ?? ""}`);
  }

  if (!parsed.stdin) {
    throw new Error("command dispatch requires --stdin.");
  }
  return parsed;
}

function parseGetArgs(args: string[]): Extract<ParsedCommandArgs, { action: "get" }> {
  const commandId = args[0];
  if (commandId === undefined) {
    throw new Error("command get requires a command id.");
  }
  const parsedCommandId = parseCommandId(commandId);
  const parsed: Extract<ParsedCommandArgs, { action: "get" }> = {
    action: "get",
    commandId: parsedCommandId,
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms") {
      const timeoutMs = parseTimeoutMs(args[index + 1], "--timeout-ms");
      parsed.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }
    throw new Error(`Unknown command get option: ${arg ?? ""}`);
  }
  return parsed;
}

function parseTimeoutMs(value: string | undefined, option: string): number {
  return parsePositiveIntegerOption(value, option);
}

function parseCommandId(value: string): CommandId {
  const parsed = CommandIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid command id: ${parsed.error.message}`);
  }
  return parsed.data;
}
