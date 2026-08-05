import { safeErrorToToast } from "../../services/errors/errors.js";
import { removePendingRemoveWorktreeRow } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import {
  type DashboardCommandOperationInput,
  executeDashboardCommandError,
} from "./commandExecutionError.js";
import type { RemoveWorktreeOperation } from "./types.js";

export async function runRemoveWorktreeOperation(
  input: DashboardCommandOperationInput<RemoveWorktreeOperation>,
): Promise<void> {
  const { operation } = input;
  const failure = await executeDashboardCommandError({
    service: input.service,
    command: operation.command,
    clientLabel: input.clientLabel,
  });
  if (failure !== undefined) {
    input.scope.commit(() => {
      const withoutPending = removePendingRemoveWorktreeRow(
        input.store.getState(),
        operation.localId,
      );
      input.store.setState(addTuiToast(withoutPending, safeErrorToToast(failure)));
    });
  }
}
