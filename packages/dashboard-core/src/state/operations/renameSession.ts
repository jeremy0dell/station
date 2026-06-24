import type { CommandId, SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { toSafeError } from "../../services/errors/errors.js";
import type { TuiObserverService } from "../../services/types.js";
import { bindPendingRenameSessionTitle } from "../localRows.js";
import type { TuiStore } from "../store.js";
import type { RenameSessionOperation } from "./types.js";

export async function runRenameSessionOperation(
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
  operation: RenameSessionOperation,
  clientLabel: string,
  markRenameSessionFailed: (sessionId: string) => void,
  markCommandFailureHandled: (commandId: CommandId) => void,
  hasCommandFailureBeenHandled: (commandId: CommandId) => boolean,
  addSafeErrorToast: (error: SafeError) => void,
  addRenameSuccessToast: () => void,
): Promise<void> {
  let commandId: CommandId | undefined;
  try {
    const receipt = await service.dispatch(operation.command);
    if (!receipt.accepted) {
      const safeError = receipt.error ?? {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: `${operation.command.type} was rejected.`,
      };
      markRenameSessionFailed(operation.sessionId);
      addSafeErrorToast(safeError);
      return;
    }

    commandId = receipt.commandId;
    store.setState(
      bindPendingRenameSessionTitle(store.getState(), operation.sessionId, receipt.commandId),
    );
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "succeeded") {
      addRenameSuccessToast();
      return;
    }

    const alreadyHandled = hasCommandFailureBeenHandled(completion.commandId);
    markCommandFailureHandled(completion.commandId);
    markRenameSessionFailed(operation.sessionId);
    if (!alreadyHandled) {
      addSafeErrorToast(completion.error);
    }
  } catch (error: unknown) {
    if (commandId !== undefined) {
      markCommandFailureHandled(commandId);
    }
    markRenameSessionFailed(operation.sessionId);
    addSafeErrorToast(toSafeError(error, { clientLabel }));
  }
}
