import {
  executeObserverCommand,
  type ObserverCommandExecutionResult,
  type StationClientStateSource,
} from "@station/client";
import type {
  ProjectView,
  ProviderId,
  SafeError,
  SessionCreateCommandResult,
  SessionGroupPlacementIntent,
  SourceSessionGroupPlacementIntent,
  StationCommand,
  StationSnapshot,
} from "@station/contracts";
import { withTimeout } from "@station/runtime";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildCreateSessionCommand, buildForkSessionCommand } from "../commandBuilders.js";
import type { CreatedSessionUiPolicy } from "./createdSession.js";
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
  group?: SessionGroupPlacementIntent;
};

/** Product values required to fork a managed session. */
export type ForkManagedSessionRequest = {
  project: ProjectView;
  sourceWorktreeId: string;
  title: string;
  hiddenBranch: string;
  copyDirty: boolean;
  group?: SourceSessionGroupPlacementIntent;
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
  source: StationClientStateSource;
  clientLabel?: string;
  policyForTerminalProvider(provider: ProviderId): CreatedSessionUiPolicy;
};

/**
 * Create Observer-backed managed-session execution without dashboard state access.
 *
 * Deliberate Create retains its sheet without an optimistic row, Quick retains failed
 * optimistic rows, and Fork preserves its existing no-row behavior. Create and Quick
 * share one canonical-result path that produces only a data-only UI command.
 */
export function createObserverManagedSessionCapabilities(
  options: ObserverManagedSessionCapabilitiesOptions,
): ManagedSessionCapabilities {
  const create = (request: CreateManagedSessionRequest): DashboardExecutionHandle =>
    dashboardExecution(runCreate(options, request, "remove-immediately"));
  const quickCreate = (request: CreateManagedSessionRequest): DashboardExecutionHandle =>
    dashboardExecution(runCreate(options, request, "retain-failed"), {
      optimistic: "pending-create",
      successDisposition: "remove-immediately",
    });
  return {
    create,
    quickCreate,
    fork: (request) => dashboardExecution(runFork(options, request)),
  };
}

async function runCreate(
  options: ObserverManagedSessionCapabilitiesOptions,
  request: CreateManagedSessionRequest,
  disposition: "remove-immediately" | "retain-failed",
): Promise<DashboardExecutionResult> {
  try {
    const command = buildCreateSessionCommand({
      project: request.project,
      title: request.title,
      branch: request.hiddenBranch,
      harnessProvider: request.harness,
      ...(request.group === undefined ? {} : { group: request.group }),
    });
    if (command.type !== "session.create") {
      return invalidCommandFailure("session.create", disposition);
    }
    return await dispatchCreateAndWait(options, command, request, disposition);
  } catch (error: unknown) {
    return {
      kind: "failure",
      error: toSafeError(error, { clientLabel: options.clientLabel ?? "TUI" }),
      disposition,
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
    ...(request.group === undefined ? {} : { group: request.group }),
    ...(request.inheritedHarness === undefined
      ? {}
      : { harnessProvider: request.inheritedHarness }),
  });
  if (command.type !== "session.fork") {
    return invalidCommandFailure("session.fork", "remove-immediately");
  }
  return dispatchAndWait(options, command, "remove-immediately");
}

const CREATED_SESSION_APPEAR_TIMEOUT_MS = 10_000;

async function dispatchCreateAndWait(
  options: ObserverManagedSessionCapabilitiesOptions,
  command: Extract<StationCommand, { type: "session.create" }>,
  request: CreateManagedSessionRequest,
  disposition: "remove-immediately" | "retain-failed",
): Promise<DashboardExecutionResult> {
  const execution = await executeObserverCommand(options.service, command, {
    clientLabel: options.clientLabel ?? "TUI",
  });
  if (execution.status !== "succeeded") {
    if (execution.status === "accepted") {
      return createdSessionUnconfirmed(
        "The session was created, but completion was not confirmed.",
      );
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

  const result = execution.result;
  const resultError = validateCreateResult(command, request, result);
  if (resultError !== undefined || result === undefined) {
    return createdSessionUnconfirmed(
      resultError ?? "The session was created, but its durable identity was not returned.",
    );
  }

  let created = await waitForCanonicalCreatedSession(options.source, request, result);
  if (created === undefined) {
    try {
      created = resolveCanonicalCreatedSession(
        await options.service.loadSnapshot(),
        request,
        result,
      );
    } catch {
      // Creation already succeeded; the bounded notice below is the only safe outcome.
    }
  }
  if (created === undefined) {
    return createdSessionUnconfirmed(
      "The session was created, but its canonical dashboard identity did not converge.",
    );
  }

  return {
    kind: "success",
    createdSessionCommand: {
      type: "createdSession.applyUiPolicy",
      target: {
        sessionId: result.sessionId,
        projectId: result.projectId,
        worktreeId: result.worktreeId,
        branch: created.branch,
        terminalProvider: result.resolvedPlacement.provider,
      },
      policy: options.policyForTerminalProvider(result.resolvedPlacement.provider),
    },
  };
}

function validateCreateResult(
  command: Extract<StationCommand, { type: "session.create" }>,
  request: CreateManagedSessionRequest,
  result: SessionCreateCommandResult | undefined,
): string | undefined {
  if (result === undefined) return undefined;
  if (
    result.projectId !== request.project.id ||
    result.resolvedPlacement.provider !== command.payload.terminal.provider
  ) {
    return "The session was created, but its durable identity did not match the request.";
  }
  if (request.group?.kind === "existing" && result.resolvedGroupId !== request.group.groupId) {
    return "The session was created, but its durable Group placement did not match the request.";
  }
  if (request.group?.kind === "create" && result.resolvedGroupId === undefined) {
    return "The session was created, but its durable Group identity was missing.";
  }
  if (request.group === undefined && result.resolvedGroupId !== undefined) {
    return "The session was created, but its durable Group placement was unexpected.";
  }
  return undefined;
}

async function waitForCanonicalCreatedSession(
  source: StationClientStateSource,
  request: CreateManagedSessionRequest,
  result: SessionCreateCommandResult,
): Promise<{ branch: string } | undefined> {
  const existing = resolveCanonicalCreatedSession(source.getState().snapshot, request, result);
  if (existing !== undefined) return existing;

  try {
    return await withTimeout(
      ({ signal }) =>
        new Promise((resolve) => {
          let settled = false;
          let unsubscribe = (): void => undefined;
          const settle = (target: { branch: string } | undefined): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            unsubscribe();
            resolve(target);
          };
          const onAbort = (): void => settle(undefined);

          signal.addEventListener("abort", onAbort, { once: true });
          unsubscribe = source.subscribe(() => {
            const target = resolveCanonicalCreatedSession(
              source.getState().snapshot,
              request,
              result,
            );
            if (target !== undefined) settle(target);
          });

          const target = resolveCanonicalCreatedSession(
            source.getState().snapshot,
            request,
            result,
          );
          if (target !== undefined) settle(target);
        }),
      {
        timeoutMs: CREATED_SESSION_APPEAR_TIMEOUT_MS,
        error: {
          tag: "RuntimeError",
          code: "CREATED_SESSION_WAIT_FAILED",
          message: "Waiting for the created session failed.",
        },
        timeoutError: {
          tag: "TimeoutError",
          code: "CREATED_SESSION_WAIT_TIMEOUT",
          message: "The created session did not converge before the deadline.",
        },
      },
    );
  } catch {
    return undefined;
  }
}

function resolveCanonicalCreatedSession(
  snapshot: StationSnapshot | undefined,
  request: CreateManagedSessionRequest,
  result: SessionCreateCommandResult,
): { branch: string } | undefined {
  const session = snapshot?.sessions.find(
    (candidate) =>
      candidate.id === result.sessionId &&
      candidate.projectId === result.projectId &&
      candidate.worktreeId === result.worktreeId &&
      candidate.terminal?.provider === result.resolvedPlacement.provider,
  );
  const row = snapshot?.rows.find(
    (candidate) =>
      candidate.id === result.worktreeId &&
      candidate.projectId === result.projectId &&
      candidate.branch === request.hiddenBranch,
  );
  if (session === undefined || row === undefined) return undefined;

  const owningGroup = snapshot?.sessionGroups.find((group) =>
    group.sessionIds.includes(result.sessionId),
  );
  if (result.resolvedGroupId === undefined) {
    return owningGroup === undefined ? { branch: row.branch } : undefined;
  }
  return owningGroup?.id === result.resolvedGroupId &&
    owningGroup.projectId === result.projectId &&
    owningGroup.parentGroupId === undefined
    ? { branch: row.branch }
    : undefined;
}

function createdSessionUnconfirmed(message: string): DashboardExecutionResult {
  return {
    kind: "success",
    notice: {
      kind: "error",
      message,
      hint: "Refresh the dashboard before creating another session.",
    },
  };
}

async function dispatchAndWait(
  options: ObserverManagedSessionCapabilitiesOptions,
  command: Extract<StationCommand, { type: "session.fork" }>,
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
