import {
  executeObserverCommand,
  type ObserverCommandExecutionResult,
  type StationClientStateSource,
} from "@station/client";
import type {
  ProjectId,
  ProviderId,
  SafeError,
  SessionId,
  StationCommand,
  TerminalFocusOrigin,
  WorktreeId,
} from "@station/contracts";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import type { DashboardFocusTarget } from "./activation.js";
import type { DashboardExecutionResult } from "./execution.js";

/** Renderer-resolved behavior applied after one exact managed session creation. */
export type CreatedSessionUiPolicy = {
  focusCreatedSession: boolean;
  dismissDashboard: boolean;
};

/**
 * Dashboard-local, data-only effect bound to one canonical create result.
 * This command is never persisted, dispatched to Observer, or placed on a wire contract.
 */
export type CreatedSessionUiCommand = {
  type: "createdSession.applyUiPolicy";
  target: {
    sessionId: SessionId;
    projectId: ProjectId;
    worktreeId: WorktreeId;
    branch: string;
    terminalProvider: ProviderId;
  };
  policy: CreatedSessionUiPolicy;
};

/** Exact-target renderer authority for focus-before-dismiss post-create behavior. */
export type CreatedSessionCapabilities = {
  applyUiPolicy(command: CreatedSessionUiCommand): Promise<DashboardExecutionResult>;
};

export type ObserverCreatedSessionCapabilitiesOptions = {
  service: ObserverService;
  source: StationClientStateSource;
  clientLabel?: string;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  dismissDashboard(): Promise<void>;
};

/**
 * Create the standalone exact-session effect. Its focus path can only dispatch
 * `terminal.focus`; it cannot start, resume, or otherwise repair the target.
 * Dismissal runs only after confirmed focus success when both policy flags are true.
 */
export function createObserverCreatedSessionCapabilities(
  options: ObserverCreatedSessionCapabilitiesOptions,
): CreatedSessionCapabilities {
  return {
    applyUiPolicy: (command) => applyObserverCreatedSessionPolicy(options, command),
  };
}

async function applyObserverCreatedSessionPolicy(
  options: ObserverCreatedSessionCapabilitiesOptions,
  command: CreatedSessionUiCommand,
): Promise<DashboardExecutionResult> {
  if (!command.policy.focusCreatedSession) {
    if (command.policy.dismissDashboard) {
      try {
        await options.dismissDashboard();
      } catch (error: unknown) {
        return executionFailure(error);
      }
    }
    return { kind: "success" };
  }

  const targetError = validateExactFocusableTarget(options.source, command);
  if (targetError !== undefined) {
    return failure(targetError);
  }

  try {
    const focusTarget = await resolveConfiguredFocusTarget(options);
    const focusCommand: Extract<StationCommand, { type: "terminal.focus" }> = {
      type: "terminal.focus",
      payload: {
        sessionId: command.target.sessionId,
        ...(focusTarget === undefined ? {} : { origin: focusTarget.origin }),
      },
    };
    const execution = await executeObserverCommand(options.service, focusCommand, {
      waitForCompletion: true,
      clientLabel: options.clientLabel ?? "TUI",
    });
    const focusFailure = observerFocusFailure(execution);
    if (focusFailure !== undefined) {
      return failure(focusFailure);
    }
    if (command.policy.dismissDashboard) {
      const dismiss = focusTarget?.onFocusSuccess ?? options.dismissDashboard;
      await dismiss();
    }
    return { kind: "success" };
  } catch (error: unknown) {
    return executionFailure(error);
  }
}

function validateExactFocusableTarget(
  source: StationClientStateSource,
  command: CreatedSessionUiCommand,
): SafeError | undefined {
  const snapshot = source.getState().snapshot;
  const session = snapshot?.sessions.find(
    (candidate) =>
      candidate.id === command.target.sessionId &&
      candidate.projectId === command.target.projectId &&
      candidate.worktreeId === command.target.worktreeId,
  );
  const row = snapshot?.rows.find(
    (candidate) =>
      candidate.id === command.target.worktreeId &&
      candidate.projectId === command.target.projectId &&
      candidate.branch === command.target.branch,
  );
  if (
    session === undefined ||
    row === undefined ||
    session.terminal?.provider !== command.target.terminalProvider
  ) {
    return createdSessionError(
      "CREATED_SESSION_TARGET_MISMATCH",
      "The created session no longer matches its canonical terminal target.",
    );
  }
  if (session.terminal.focusable !== true) {
    return createdSessionError(
      "CREATED_SESSION_NOT_FOCUSABLE",
      `The created session cannot be focused from the dashboard's "${command.target.terminalProvider}" terminal context.`,
    );
  }
  return undefined;
}

function observerFocusFailure(
  execution: ObserverCommandExecutionResult<Extract<StationCommand, { type: "terminal.focus" }>>,
): SafeError | undefined {
  if (execution.status === "succeeded") return undefined;
  if (execution.status === "rejected") {
    return (
      execution.receipt.error ??
      createdSessionError(
        "CREATED_SESSION_FOCUS_REJECTED",
        "Focusing the created session was rejected.",
      )
    );
  }
  if (execution.status === "accepted") {
    return createdSessionError(
      "CREATED_SESSION_FOCUS_UNCONFIRMED",
      "Focusing the created session was not confirmed.",
    );
  }
  return execution.error;
}

function resolveConfiguredFocusTarget(
  options: ObserverCreatedSessionCapabilitiesOptions,
): Promise<DashboardFocusTarget | undefined> {
  if (options.resolveFocusTarget !== undefined) {
    return options.resolveFocusTarget();
  }
  return Promise.resolve(
    options.focusOrigin === undefined ? undefined : { origin: options.focusOrigin },
  );
}

function executionFailure(error: unknown): DashboardExecutionResult {
  return failure(toSafeError(error, { clientLabel: "TUI" }));
}

function failure(error: SafeError): DashboardExecutionResult {
  return { kind: "failure", error, disposition: "remove-immediately" };
}

function createdSessionError(code: string, message: string): SafeError {
  return {
    tag: "TuiCreatedSessionError",
    code,
    message,
    hint: "The session was created successfully and remains available in the dashboard.",
  };
}
