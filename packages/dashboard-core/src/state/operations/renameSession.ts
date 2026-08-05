import { executeObserverCommand } from "@station/client";
import type { SafeError } from "@station/contracts";
import type { ObserverService } from "../../services/types.js";
import type { RenameSessionOperation } from "./types.js";

export async function runRenameSessionOperation(input: {
  service: ObserverService;
  operation: RenameSessionOperation;
  clientLabel: string;
  markRenameSessionFailed(sessionId: string): void;
  addSafeErrorToast(error: SafeError): void;
  addRenameSuccessToast(): void;
}): Promise<void> {
  const { operation } = input;
  const execution = await executeObserverCommand(input.service, operation.command, {
    clientLabel: input.clientLabel,
  });
  if (execution.status === "succeeded" || execution.status === "accepted") {
    input.addRenameSuccessToast();
    return;
  }

  input.markRenameSessionFailed(operation.sessionId);
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
