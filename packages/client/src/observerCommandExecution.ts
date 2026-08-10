import type {
  CommandReceipt,
  SafeError,
  StationCommand,
  StationSnapshot,
} from "@station/contracts";
import { toSafeError } from "./errors.js";
import type { ObserverService } from "./types.js";

/**
 * Normalized outcome of dispatching one typed Observer command and, by default,
 * observing its terminal completion.
 *
 * Accepted receipts stay attached to completion and thrown-wait outcomes so
 * callers can preserve command and trace identity in diagnostics or notices.
 * Accepted Group terminal outcomes are returned only after a canonical load.
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
 * Accepted Group commands load canonical state after terminal completion. A
 * stale single-session assignment failure names that session's loaded destination.
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
    const snapshot = command.type.startsWith("sessionGroup.")
      ? await service.loadSnapshot()
      : undefined;
    return completion.status === "succeeded"
      ? { status: "succeeded", receipt }
      : {
          status: "failed",
          receipt,
          error: normalizeGroupAssignmentConflict(
            withReceiptIdentity(completion.error, receipt),
            command,
            snapshot,
          ),
        };
  } catch (error: unknown) {
    return {
      status: "thrown",
      receipt,
      error: withReceiptIdentity(normalizeThrownFailure(error, options.clientLabel), receipt),
    };
  }
}

function normalizeGroupAssignmentConflict(
  error: SafeError,
  command: StationCommand,
  snapshot: StationSnapshot | undefined,
): SafeError {
  if (
    error.code !== "SESSION_GROUP_ASSIGNMENT_CONFLICT" ||
    command.type !== "sessionGroup.updateMembership" ||
    snapshot === undefined
  ) {
    return error;
  }
  const referencedSessions = [...(command.payload.add ?? []), ...(command.payload.remove ?? [])];
  if (referencedSessions.length !== 1) {
    return error;
  }
  const sessionId = referencedSessions[0]?.sessionId;
  if (sessionId === undefined || !snapshot.sessions.some((session) => session.id === sessionId)) {
    return error;
  }
  const destination = snapshot.sessionGroups.find((group) => group.sessionIds.includes(sessionId));
  return {
    ...error,
    message:
      destination === undefined
        ? "The session's Group changed; it is now ungrouped."
        : `The session's Group changed; it is now in "${destination.name}".`,
    hint: "Review the canonical destination before retrying the membership change.",
    sessionId,
  };
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
