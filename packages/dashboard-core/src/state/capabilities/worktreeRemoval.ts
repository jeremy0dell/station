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

/** Options for Observer-backed worktree removal with optional renderer-owned settlement hooks. */
export type ObserverWorktreeRemovalCapabilitiesOptions = {
  service: ObserverService;
  clientLabel?: string;
  /** Runs only after Observer validates and reserves the exact worktree mutation slot. */
  beforeRemove?: (request: RemoveWorktreeRequest) => Promise<void>;
  /** Finalizes renderer layout only after canonical removal succeeds. */
  afterRemove?: (request: RemoveWorktreeRequest) => Promise<void> | void;
};

/** Create reserved worktree removal execution while keeping renderer mechanics outside dashboard-core. */
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
    const preparation = await options.service.prepareWorktreeRemoval(request.command.payload);
    const preparedRequest = withRemovalReservation(request, preparation);
    try {
      if (preparation.externalTerminalExitRequired && options.beforeRemove === undefined) {
        throw externalTerminalSettlementUnavailable(request.worktreeId);
      }
      await options.beforeRemove?.(preparedRequest);
    } catch (error) {
      await options.service
        .cancelWorktreeRemoval({ reservationId: preparation.reservationId })
        .catch(() => undefined);
      throw error;
    }

    const execution = await executeObserverCommand(options.service, preparedRequest.command, {
      clientLabel: options.clientLabel ?? "TUI",
    });
    if (execution.status === "succeeded" || execution.status === "accepted") {
      await options.afterRemove?.(preparedRequest);
      return { kind: "success" };
    }
    if (execution.status === "rejected") {
      await options.service
        .cancelWorktreeRemoval({ reservationId: preparation.reservationId })
        .catch(() => undefined);
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

function withRemovalReservation(
  request: RemoveWorktreeRequest,
  preparation: Awaited<ReturnType<ObserverService["prepareWorktreeRemoval"]>>,
): RemoveWorktreeRequest {
  return {
    ...request,
    command: {
      ...request.command,
      payload: {
        ...request.command.payload,
        projectId: preparation.projectId,
        removalReservationId: preparation.reservationId,
      },
    },
  };
}

function externalTerminalSettlementUnavailable(worktreeId: WorktreeId): SafeError {
  return {
    tag: "TerminalProviderError",
    code: "EXTERNAL_TERMINAL_SETTLEMENT_UNAVAILABLE",
    message: "This worktree has a terminal owned by another Station renderer.",
    hint: "Close it from the native Station workspace, then retry removal.",
    worktreeId,
  };
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
