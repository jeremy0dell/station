import type { StationConfig } from "@station/config";
import type {
  CommandId,
  CommandReceipt,
  CommandRecord,
  SafeError,
  StationCommand,
} from "@station/contracts";
import { CommandIdSchema, StationCommandSchema } from "@station/contracts";
import { createObserverClient, type ObserverApi, type ObserverClient } from "@station/protocol";
import { isSafeError, runRuntimeBoundaryWithTimeout } from "@station/runtime";
import { parsePositiveIntegerOption } from "../args.js";
import {
  type ObserverProcessDeps,
  type ObserverStatus,
  observerStatusErrorMessage,
  startObserver,
} from "../observerProcess.js";
import { resolveObserverPaths } from "../paths.js";

export type CommandCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandDispatchAcceptedResult = {
  status: "accepted" | "rejected";
  receipt: CommandReceipt;
};

export type CommandDispatchCompletedResult = {
  status: "succeeded" | "failed";
  receipt: CommandReceipt;
  command: CommandRecord;
};

export type CommandGetResult = {
  command: CommandRecord;
};

export type CommandCommandResult =
  | CommandDispatchAcceptedResult
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

export async function runCommandCommand(
  args: string[],
  options: CommandCommandOptions = {},
  deps: ObserverProcessDeps = {},
): Promise<CommandCommandResult> {
  const parsed = parseCommandArgs(args);
  const timeoutMs = parsed.timeoutMs ?? options.timeoutMs ?? 30_000;
  const paths = resolveObserverPaths(options.config);
  const status = await startObserver({ ...options, paths, timeoutMs }, deps);
  assertRunning(status);
  const client =
    deps.clientFactory?.(paths.socketPath) ??
    createObserverClient({ socketPath: paths.socketPath, timeoutMs });

  if (parsed.action === "get") {
    return getCommand(client, parsed.commandId);
  }

  const command = parseCommandFromStdin(options.stdin, parsed.stdin);
  const receipt = await dispatchCommand(client, command, timeoutMs);
  if (!parsed.wait || !receipt.accepted) {
    return {
      status: receipt.status,
      receipt,
    };
  }

  const record = await waitForCommand(client, receipt.commandId, timeoutMs);
  if (record.status !== "succeeded" && record.status !== "failed") {
    throw {
      tag: "TimeoutError",
      code: "COMMAND_WAIT_TIMEOUT",
      message: "Command did not finish before the timeout.",
    };
  }
  return {
    status: record.status,
    receipt,
    command: record,
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

async function getCommand(client: ObserverApi, commandId: CommandId): Promise<CommandGetResult> {
  const command = await client.getCommand(commandId);
  if (command === undefined) {
    throw missingCommandRecordError(commandId);
  }
  return {
    command,
  };
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
      timeoutError: {
        tag: "TimeoutError",
        code: "COMMAND_WAIT_TIMEOUT",
        message: "Command did not finish before the timeout.",
      },
    },
    async () => client.waitForCommand(commandId, { timeoutMs }).catch(mapCommandWaitError),
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function mapCommandWaitError(error: unknown): never {
  if (isSafeError(error) && error.tag === "TimeoutError") {
    throw {
      tag: "TimeoutError",
      code: "COMMAND_WAIT_TIMEOUT",
      message: "Command did not finish before the timeout.",
    };
  }
  throw error;
}

function parseCommandFromStdin(stdin: string | undefined, requiresStdin: boolean): StationCommand {
  if (requiresStdin && (stdin === undefined || stdin.trim().length === 0)) {
    throw new Error("command dispatch --stdin requires JSON on stdin.");
  }
  if (stdin === undefined) {
    throw new Error("command dispatch requires --stdin.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch (cause) {
    throw new Error("Invalid command JSON.", { cause });
  }

  const result = StationCommandSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid command JSON: ${result.error.message}`);
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

function assertRunning(
  status: ObserverStatus,
): asserts status is Extract<ObserverStatus, { status: "running" }> {
  if (status.status !== "running") {
    throw new Error(observerStatusErrorMessage(status));
  }
}
