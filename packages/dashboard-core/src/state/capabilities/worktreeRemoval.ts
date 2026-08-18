import { executeObserverCommand } from "@station/client";
import type { SafeError, StationCommand, WorktreeId } from "@station/contracts";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import {
  type DashboardExecutionHandle,
  type DashboardExecutionResult,
  dashboardExecution,
} from "./execution.js";

/** Product values required to remove a worktree-backed session. */
export type RemoveWorktreeRequest = {
  worktreeId: WorktreeId;
  command: Extract<StationCommand, { type: "worktree.remove" }>;
};

/** Renderer-selected authority for worktree cleanup and command execution. */
export type WorktreeRemovalCapabilities = {
  remove(request: RemoveWorktreeRequest): DashboardExecutionHandle;
};

/** Options for Observer-backed worktree removal with an optional renderer-owned preflight. */
export type ObserverWorktreeRemovalCapabilitiesOptions = {
  service: ObserverService;
  clientLabel?: string;
  beforeRemove?: (request: RemoveWorktreeRequest) => Promise<void>;
};

/** Create worktree removal execution while keeping renderer mechanics outside dashboard-core. */
export function createObserverWorktreeRemovalCapabilities(
  options: ObserverWorktreeRemovalCapabilitiesOptions,
): WorktreeRemovalCapabilities {
  return {
    remove: (request) =>
      dashboardExecution(runRemove(options, request), {
        successDisposition: "wait-for-canonical",
      }),
  };
}

async function runRemove(
  options: ObserverWorktreeRemovalCapabilitiesOptions,
  request: RemoveWorktreeRequest,
): Promise<DashboardExecutionResult> {
  try {
    await options.beforeRemove?.(request);
    const execution = await executeObserverCommand(options.service, request.command, {
      clientLabel: options.clientLabel ?? "TUI",
    });
    if (execution.status === "succeeded" || execution.status === "accepted") {
      return { kind: "success" };
    }
    return {
      kind: "failure",
      error:
        execution.status === "rejected"
          ? rejectedCommandError(execution.receipt.error)
          : execution.error,
      disposition: "remove-immediately",
    };
  } catch (error: unknown) {
    return {
      kind: "failure",
      error: toSafeError(error, { clientLabel: options.clientLabel ?? "TUI" }),
      disposition: "remove-immediately",
    };
  }
}

function rejectedCommandError(error: SafeError | undefined): SafeError {
  return (
    error ?? {
      tag: "CommandExecutionError",
      code: "COMMAND_REJECTED",
      message: "worktree.remove was rejected.",
    }
  );
}
