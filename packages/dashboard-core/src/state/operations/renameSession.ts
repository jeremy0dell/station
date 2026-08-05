import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { bindPendingRenameSessionTitle } from "../localRows.js";
import type { DashboardState } from "../types.js";
import type { RenameSessionOperation } from "./types.js";

export async function runRenameSessionOperation(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  operation: RenameSessionOperation,
  clientLabel: string,
  markRenameSessionFailed: (sessionId: string) => void,
  addSafeErrorToast: (error: SafeError) => void,
  addRenameSuccessToast: () => void,
): Promise<void> {
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

    store.setState(
      bindPendingRenameSessionTitle(store.getState(), operation.sessionId, receipt.commandId),
    );
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "succeeded") {
      addRenameSuccessToast();
      return;
    }

    markRenameSessionFailed(operation.sessionId);
    addSafeErrorToast(completion.error);
  } catch (error: unknown) {
    markRenameSessionFailed(operation.sessionId);
    addSafeErrorToast(toSafeError(error, { clientLabel }));
  }
}
