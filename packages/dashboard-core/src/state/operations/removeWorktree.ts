import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { bindPendingRemoveWorktreeRow } from "../localRows.js";
import type { DashboardState } from "../types.js";
import type { RemoveWorktreeOperation } from "./types.js";

export async function runRemoveWorktreeOperation(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  operation: RemoveWorktreeOperation,
  clientLabel: string,
  markRemoveWorktreeRowFailed: (localId: string) => void,
  addSafeErrorToast: (error: SafeError) => void,
): Promise<void> {
  try {
    const receipt = await service.dispatch(operation.command);
    if (!receipt.accepted) {
      const safeError = receipt.error ?? {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: `${operation.command.type} was rejected.`,
      };
      markRemoveWorktreeRowFailed(operation.localId);
      addSafeErrorToast(safeError);
      return;
    }

    store.setState(
      bindPendingRemoveWorktreeRow(store.getState(), operation.localId, receipt.commandId),
    );
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      markRemoveWorktreeRowFailed(operation.localId);
      addSafeErrorToast(completion.error);
    }
  } catch (error: unknown) {
    markRemoveWorktreeRowFailed(operation.localId);
    addSafeErrorToast(toSafeError(error, { clientLabel }));
  }
}
