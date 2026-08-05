import type { CommandReceipt, SafeError, StationCommand } from "@station/contracts";
import { toSafeError } from "./errors.js";
import type { ObserverService } from "./types.js";

/**
 * Normalized outcome of dispatching one typed Observer command and, by default,
 * observing its terminal completion.
 *
 * Accepted receipts stay attached to completion and thrown-wait outcomes so
 * callers can preserve command and trace identity in diagnostics or notices.
 */
export type ObserverCommandExecutionResult =
  | { status: "rejected"; receipt: CommandReceipt; error: SafeError }
  | { status: "accepted"; receipt: CommandReceipt }
  | { status: "succeeded"; receipt: CommandReceipt }
  | { status: "failed"; receipt: CommandReceipt; error: SafeError }
  | { status: "thrown"; error: SafeError; receipt?: CommandReceipt };

type ExecuteObserverCommandOptions = {
  /** Return after an accepted receipt instead of waiting for terminal completion. */
  waitForCompletion?: boolean;
  /** Human-facing client name used only when normalizing a thrown failure. */
  clientLabel?: string;
};

/**
 * Dispatch a typed Observer command through the shared client service and
 * normalize rejection, acceptance, completion, and thrown failures once.
 *
 * This helper owns no optimistic UI policy and performs no renderer, provider,
 * or Station Host behavior.
 */
export async function executeObserverCommand(
  service: ObserverService,
  command: StationCommand,
  options: ExecuteObserverCommandOptions = {},
): Promise<ObserverCommandExecutionResult> {
  let receipt: CommandReceipt;
  try {
    receipt = await service.dispatch(command);
  } catch (error: unknown) {
    return {
      status: "thrown",
      error: normalizeThrownFailure(error, options.clientLabel),
    };
  }

  if (!receipt.accepted) {
    return {
      status: "rejected",
      receipt,
      error: withReceiptIdentity(receipt.error ?? rejectedCommandError(command), receipt),
    };
  }
  if (options.waitForCompletion === false) {
    return { status: "accepted", receipt };
  }

  try {
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    return completion.status === "succeeded"
      ? { status: "succeeded", receipt }
      : {
          status: "failed",
          receipt,
          error: withReceiptIdentity(completion.error, receipt),
        };
  } catch (error: unknown) {
    return {
      status: "thrown",
      receipt,
      error: withReceiptIdentity(normalizeThrownFailure(error, options.clientLabel), receipt),
    };
  }
}

function normalizeThrownFailure(error: unknown, clientLabel: string | undefined): SafeError {
  return clientLabel === undefined ? toSafeError(error) : toSafeError(error, { clientLabel });
}

function rejectedCommandError(command: StationCommand): SafeError {
  return {
    tag: "CommandExecutionError",
    code: "COMMAND_REJECTED",
    message: `${command.type} was rejected.`,
  };
}

function withReceiptIdentity(error: SafeError, receipt: CommandReceipt): SafeError {
  const identified: SafeError = { ...error };
  if (identified.commandId === undefined) {
    identified.commandId = receipt.commandId;
  }
  if (identified.traceId === undefined && receipt.traceId !== undefined) {
    identified.traceId = receipt.traceId;
  }
  return identified;
}
