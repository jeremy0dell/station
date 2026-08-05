import { safeErrorToToast } from "../../services/errors/errors.js";
import { removePendingRenameSessionTitle } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import {
  type DashboardCommandOperationInput,
  executeDashboardCommandError,
} from "./commandExecutionError.js";
import type { RenameSessionOperation } from "./types.js";

export async function runRenameSessionOperation(
  input: DashboardCommandOperationInput<RenameSessionOperation>,
): Promise<void> {
  const { operation } = input;
  const failure = await executeDashboardCommandError({
    service: input.service,
    command: operation.command,
    clientLabel: input.clientLabel,
  });
  input.scope.commit(() => {
    if (failure === undefined) {
      input.store.setState(
        addTuiToast(input.store.getState(), {
          kind: "success",
          message: "Session renamed.",
        }),
      );
      return;
    }
    const withoutPending = removePendingRenameSessionTitle(
      input.store.getState(),
      operation.sessionId,
    );
    input.store.setState(addTuiToast(withoutPending, safeErrorToToast(failure)));
  });
}
