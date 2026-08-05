import { executeObserverCommand, type ObserverCommandExecutionResult } from "@station/client";
import type { SafeError, StationCommand } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import type { ObserverService } from "../../services/types.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import type { DashboardState } from "../types.js";

export type DashboardCommandOperationInput<Operation extends { command: StationCommand }> = {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  operation: Operation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
};

/** Execute a command and resolve only the dashboard-facing failure, when present. */
export async function executeDashboardCommandError(input: {
  service: ObserverService;
  command: StationCommand;
  clientLabel: string;
  rejectedFallback?: (error: SafeError) => SafeError;
}): Promise<SafeError | undefined> {
  const execution = await executeObserverCommand(input.service, input.command, {
    clientLabel: input.clientLabel,
  });
  const rejectedFallback =
    input.rejectedFallback ??
    ((error: SafeError): SafeError => ({
      ...error,
      tag: "CommandExecutionError",
      code: "COMMAND_REJECTED",
      message: `${input.command.type} was rejected.`,
    }));
  return commandExecutionError(execution, rejectedFallback);
}

/** Resolve the dashboard-facing error for a normalized Observer command outcome. */
export function commandExecutionError(
  execution: ObserverCommandExecutionResult,
  rejectedFallback: (error: SafeError) => SafeError,
): SafeError | undefined {
  switch (execution.status) {
    case "accepted":
    case "succeeded":
      return undefined;
    case "failed":
    case "thrown":
      return execution.error;
    case "rejected":
      return execution.receipt.error === undefined
        ? rejectedFallback(execution.error)
        : execution.error;
  }
}
