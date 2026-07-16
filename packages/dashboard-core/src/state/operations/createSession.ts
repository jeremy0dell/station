import type { CommandId, SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { toSafeError } from "../../services/errors/errors.js";
import type { TuiObserverService } from "../../services/types.js";
import { bindPendingCreateSessionRow, removeCreateSessionLocalRow } from "../localRows.js";
import type { TuiStore } from "../store.js";
import {
  type CommandRuntimeOptions,
  prepareCreateSessionCommandForRuntime,
} from "./runtimeCommands.js";
import type { CreateSessionOperation } from "./types.js";

export async function runCreateSessionOperation(
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
  runtime: CommandRuntimeOptions,
  operation: CreateSessionOperation,
  markCreateSessionRowFailed: (localId: string, error: SafeError) => void,
  markCommandFailureHandled: (commandId: CommandId) => void,
  hasCommandFailureBeenHandled: (commandId: CommandId) => boolean,
  addSafeErrorToast: (error: SafeError) => void,
): Promise<void> {
  try {
    const prepared = await prepareCreateSessionCommandForRuntime(operation.command, runtime);
    const command = prepared.command;
    const receipt = await service.dispatch(command);
    if (!receipt.accepted) {
      const safeError = receipt.error ?? {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: `${command.type} was rejected.`,
      };
      markCreateSessionRowFailed(operation.localId, safeError);
      addSafeErrorToast(safeError);
      return;
    }

    store.setState(
      bindPendingCreateSessionRow(store.getState(), operation.localId, receipt.commandId),
    );
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "succeeded") {
      store.setState(removeCreateSessionLocalRow(store.getState(), operation.localId));
      if (prepared.target?.onFocusSuccess !== undefined) {
        try {
          await prepared.target.onFocusSuccess();
        } catch (error: unknown) {
          addSafeErrorToast(toSafeError(error, { clientLabel: runtime.clientLabel }));
        }
      }
      return;
    }

    const alreadyHandled = hasCommandFailureBeenHandled(completion.commandId);
    markCommandFailureHandled(completion.commandId);
    markCreateSessionRowFailed(operation.localId, completion.error);
    if (!alreadyHandled) {
      addSafeErrorToast(completion.error);
    }
  } catch (error: unknown) {
    const safeError = toSafeError(error, { clientLabel: runtime.clientLabel });
    markCreateSessionRowFailed(operation.localId, safeError);
    addSafeErrorToast(safeError);
  }
}
