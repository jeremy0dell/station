import { executeObserverCommand } from "@station/client";
import type { SafeError } from "@station/contracts";
import type { ObserverService } from "../../services/types.js";
import type { RemoveWorktreeOperation } from "./types.js";

export async function runRemoveWorktreeOperation(input: {
  service: ObserverService;
  operation: RemoveWorktreeOperation;
  clientLabel: string;
  markRemoveWorktreeRowFailed(localId: string): void;
  addSafeErrorToast(error: SafeError): void;
}): Promise<void> {
  const { operation } = input;
  const execution = await executeObserverCommand(input.service, operation.command, {
    clientLabel: input.clientLabel,
  });
  if (execution.status === "succeeded" || execution.status === "accepted") {
    return;
  }

  input.markRemoveWorktreeRowFailed(operation.localId);
  const error: SafeError =
    execution.status === "rejected" && execution.receipt.error === undefined
      ? {
          ...execution.error,
          tag: "CommandExecutionError",
          code: "COMMAND_REJECTED",
          message: `${operation.command.type} was rejected.`,
        }
      : execution.error;
  input.addSafeErrorToast(error);
}
