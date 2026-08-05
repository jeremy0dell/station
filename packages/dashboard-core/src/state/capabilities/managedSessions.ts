import { executeObserverCommand, type ObserverCommandExecutionResult } from "@station/client";
import type {
  ProjectView,
  ProviderId,
  SafeError,
  StationCommand,
  TerminalFocusOrigin,
} from "@station/contracts";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildCreateSessionCommand, buildForkSessionCommand } from "../commandBuilders.js";
import type { DashboardFocusTarget } from "./activation.js";
import {
  type DashboardExecutionHandle,
  type DashboardExecutionResult,
  dashboardExecution,
} from "./execution.js";

/** Product values required to create a managed session. */
export type CreateManagedSessionRequest = {
  project: ProjectView;
  title: string;
  hiddenBranch: string;
  harness: ProviderId;
};

/** Product values required to fork a managed session. */
export type ForkManagedSessionRequest = {
  project: ProjectView;
  sourceWorktreeId: string;
  title: string;
  hiddenBranch: string;
  copyDirty: boolean;
  inheritedHarness?: ProviderId;
};

/** Renderer-selected authority for Create, Fork, and Quick Session execution. */
export type ManagedSessionCapabilities = {
  create(request: CreateManagedSessionRequest): DashboardExecutionHandle;
  quickCreate(request: CreateManagedSessionRequest): DashboardExecutionHandle;
  fork(request: ForkManagedSessionRequest): DashboardExecutionHandle;
};

/** Options for framework-neutral Observer-backed managed-session execution. */
export type ObserverManagedSessionCapabilitiesOptions = {
  service: ObserverService;
  clientLabel?: string;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
};

/**
 * Create Observer-backed managed-session execution without dashboard state access.
 *
 * Create and Quick retain failed optimistic rows, while Fork preserves its existing
 * no-row behavior; renderer focus claims are resolved only for Create and Quick.
 */
export function createObserverManagedSessionCapabilities(
  options: ObserverManagedSessionCapabilitiesOptions,
): ManagedSessionCapabilities {
  const create = (request: CreateManagedSessionRequest): DashboardExecutionHandle =>
    dashboardExecution(runCreate(options, request), {
      optimistic: "pending-create",
      successDisposition: "remove-immediately",
    });
  return {
    create,
    quickCreate: create,
    fork: (request) => dashboardExecution(runFork(options, request)),
  };
}

async function runCreate(
  options: ObserverManagedSessionCapabilitiesOptions,
  request: CreateManagedSessionRequest,
): Promise<DashboardExecutionResult> {
  try {
    const focusTarget = await resolveFocusTarget(options);
    let command = buildCreateSessionCommand({
      project: request.project,
      title: request.title,
      branch: request.hiddenBranch,
      harnessProvider: request.harness,
    });
    if (command.type !== "session.create") {
      return invalidCommandFailure("session.create", "retain-failed");
    }
    if (focusTarget !== undefined) {
      command = {
        ...command,
        payload: {
          ...command.payload,
          terminal: {
            ...command.payload.terminal,
            focus: true,
            origin: focusTarget.origin,
          },
        },
      };
    }
    const result = await dispatchAndWait(options, command, "retain-failed");
    if (result.kind !== "success") {
      return result;
    }
    await focusTarget?.onFocusSuccess?.();
    return { kind: "success" };
  } catch (error: unknown) {
    return {
      kind: "failure",
      error: toSafeError(error, { clientLabel: options.clientLabel ?? "TUI" }),
      disposition: "retain-failed",
    };
  }
}

async function runFork(
  options: ObserverManagedSessionCapabilitiesOptions,
  request: ForkManagedSessionRequest,
): Promise<DashboardExecutionResult> {
  const command = buildForkSessionCommand({
    project: request.project,
    sourceWorktreeId: request.sourceWorktreeId,
    title: request.title,
    branch: request.hiddenBranch,
    copyDirty: request.copyDirty,
    ...(request.inheritedHarness === undefined
      ? {}
      : { harnessProvider: request.inheritedHarness }),
  });
  if (command.type !== "session.fork") {
    return invalidCommandFailure("session.fork", "remove-immediately");
  }
  return dispatchAndWait(options, command, "remove-immediately");
}

async function dispatchAndWait(
  options: ObserverManagedSessionCapabilitiesOptions,
  command: Extract<StationCommand, { type: "session.create" | "session.fork" }>,
  disposition: "remove-immediately" | "retain-failed",
): Promise<DashboardExecutionResult> {
  const execution = await executeObserverCommand(options.service, command, {
    clientLabel: options.clientLabel ?? "TUI",
  });
  if (execution.status === "succeeded" || execution.status === "accepted") {
    return { kind: "success" };
  }
  return {
    kind: "failure",
    error:
      execution.status === "rejected"
        ? rejectedCommandError(command.type, execution)
        : execution.error,
    disposition,
  };
}

function rejectedCommandError(
  type: StationCommand["type"],
  execution: Extract<ObserverCommandExecutionResult, { status: "rejected" }>,
): SafeError {
  return (
    execution.receipt.error ?? {
      ...execution.error,
      tag: "CommandExecutionError",
      code: "COMMAND_REJECTED",
      message: `${type} was rejected.`,
    }
  );
}

function invalidCommandFailure(
  type: "session.create" | "session.fork",
  disposition: "remove-immediately" | "retain-failed",
): DashboardExecutionResult {
  return {
    kind: "failure",
    disposition,
    error: {
      tag: "CommandValidationError",
      code: "INVALID_DASHBOARD_COMMAND",
      message: `Could not construct ${type}.`,
    },
  };
}

async function resolveFocusTarget(
  options: ObserverManagedSessionCapabilitiesOptions,
): Promise<DashboardFocusTarget | undefined> {
  const resolved = await options.resolveFocusTarget?.();
  if (resolved !== undefined) {
    return resolved;
  }
  return options.focusOrigin === undefined ? undefined : { origin: options.focusOrigin };
}
