import type { StationClientStateSource } from "@station/client";
import {
  type SafeError,
  type StationCommand,
  type StationSnapshot,
  type TerminalFocusOrigin,
  worktreeHasLiveAgent,
} from "@station/contracts";
import { toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildResumeAgentCommand, buildStartAgentCommand } from "../commandBuilders.js";
import {
  type DashboardExecutionHandle,
  type DashboardExecutionResult,
  dashboardExecution,
} from "./execution.js";

/** Stable semantic request for focusing, starting, or resuming one selected session. */
export type SessionActivationRequest = {
  sessionId: string;
  projectId: string;
  worktreeId: string;
  branch: string;
  preferredObserverAction: "focus" | "start" | "resume";
};

/** Renderer-selected authority for activating a canonical dashboard session. */
export type SessionActivationCapabilities = {
  activate(request: SessionActivationRequest): DashboardExecutionHandle;
};

/** Focus origin plus exact success authority resolved by a renderer boundary. */
export type DashboardFocusTarget = {
  origin: TerminalFocusOrigin;
  onFocusSuccess?: () => Promise<void>;
};

/** Options for the framework-neutral Observer-backed activation capability. */
export type ObserverActivationCapabilitiesOptions = {
  service: ObserverService;
  source: StationClientStateSource;
  clientLabel?: string;
  focusOrigin?: TerminalFocusOrigin;
  resolveFocusTarget?: () => Promise<DashboardFocusTarget | undefined>;
  waitForFocusCompletion?: boolean;
  onFocusSuccess?: () => Promise<void>;
};

const STALE_TARGET_NOTICE = "That dashboard item is no longer available.";

/**
 * Create Observer-backed session activation without receiving dashboard state.
 *
 * Stable request identities are revalidated against canonical client state immediately
 * before command construction; popup focus authority is resolved only at execution time.
 */
export function createObserverActivationCapabilities(
  options: ObserverActivationCapabilitiesOptions,
): SessionActivationCapabilities {
  return {
    activate: (request) => {
      const target = resolveCanonicalTarget(options.source, request);
      if (target.kind === "notice") {
        return dashboardExecution({ kind: "notice", notice: target.notice });
      }
      const action = worktreeHasLiveAgent(target.row)
        ? "focus"
        : target.row.recovery === undefined
          ? "start"
          : "resume";
      if (action === "focus") {
        return dashboardExecution(runFocus(options, request.sessionId));
      }
      return dashboardExecution(runStartOrResume(options, request, action), {
        optimistic: "pending-start",
        successDisposition: "wait-for-canonical",
      });
    },
  };
}

type CanonicalActivationTarget =
  | {
      kind: "target";
      snapshot: StationSnapshot;
      row: StationSnapshot["rows"][number];
      project: StationSnapshot["projects"][number];
    }
  | { kind: "notice"; notice: { kind: "info"; message: string } };

function resolveCanonicalTarget(
  source: StationClientStateSource,
  request: SessionActivationRequest,
): CanonicalActivationTarget {
  const snapshot = source.getState().snapshot;
  const session = snapshot?.sessions.find(
    (candidate) =>
      candidate.id === request.sessionId &&
      candidate.projectId === request.projectId &&
      candidate.worktreeId === request.worktreeId,
  );
  const row = snapshot?.rows.find(
    (candidate) =>
      candidate.id === request.worktreeId &&
      candidate.projectId === request.projectId &&
      candidate.branch === request.branch,
  );
  const project = snapshot?.projects.find((candidate) => candidate.id === request.projectId);
  if (
    snapshot === undefined ||
    session === undefined ||
    row === undefined ||
    project === undefined
  ) {
    return { kind: "notice", notice: { kind: "info", message: STALE_TARGET_NOTICE } };
  }
  if (worktreeHasLiveAgent(row) && session.terminal?.focusable !== true) {
    return {
      kind: "notice",
      notice: {
        kind: "info",
        message:
          session.terminal === undefined
            ? "This session has no focusable terminal."
            : `This agent runs in the "${session.terminal.provider}" terminal and can't be focused from the dashboard.`,
      },
    };
  }
  return { kind: "target", snapshot, row, project };
}

async function runStartOrResume(
  options: ObserverActivationCapabilitiesOptions,
  request: SessionActivationRequest,
  action: "start" | "resume",
): Promise<DashboardExecutionResult> {
  const target = resolveCanonicalTarget(options.source, request);
  if (target.kind === "notice") {
    return { kind: "notice", notice: target.notice };
  }
  let command =
    action === "resume"
      ? buildResumeAgentCommand(target.row, target.project)
      : buildStartAgentCommand(target.row, target.project);
  try {
    const focusTarget = await resolveConfiguredFocusTarget(options);
    if (focusTarget !== undefined) {
      command = withCommandFocusOrigin(command, focusTarget.origin);
    }
    const completed = await dispatchAndWait(options, command);
    if (completed.kind !== "success") {
      return completed;
    }
    let snapshot = options.source.getState().snapshot;
    if (sessionIdForStartedWorktree(snapshot, request.worktreeId) === undefined) {
      await options.service.loadSnapshot();
      snapshot = options.source.getState().snapshot;
    }
    const sessionId = sessionIdForStartedWorktree(snapshot, request.worktreeId);
    if (sessionId === undefined) {
      return { kind: "success" };
    }
    return await runFocus(options, sessionId);
  } catch (error: unknown) {
    return executionFailure(error, options.clientLabel);
  }
}

async function runFocus(
  options: ObserverActivationCapabilitiesOptions,
  sessionId: string,
): Promise<DashboardExecutionResult> {
  const session = options.source
    .getState()
    .snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    return { kind: "notice", notice: { kind: "info", message: STALE_TARGET_NOTICE } };
  }
  if (session.terminal?.focusable !== true) {
    return {
      kind: "notice",
      notice: {
        kind: "info",
        message:
          session.terminal === undefined
            ? "This session has no focusable terminal."
            : `This agent runs in the "${session.terminal.provider}" terminal and can't be focused from the dashboard.`,
      },
    };
  }

  try {
    const focusTarget = await resolveConfiguredFocusTarget(options);
    const command: Extract<StationCommand, { type: "terminal.focus" }> = {
      type: "terminal.focus",
      payload: {
        sessionId,
        ...(focusTarget === undefined ? {} : { origin: focusTarget.origin }),
      },
    };
    const readiness = readinessForSession(options.source.getState().snapshot, sessionId);
    const waitsForCompletion =
      options.waitForFocusCompletion === true ||
      focusTarget?.onFocusSuccess !== undefined ||
      options.onFocusSuccess !== undefined ||
      readiness !== undefined;
    const receipt = await options.service.dispatch(command);
    if (!receipt.accepted) {
      return rejectedExecution(command.type, receipt.error);
    }
    if (!waitsForCompletion) {
      return {
        kind: "notice",
        notice: {
          kind: "success",
          message: `${command.type} queued`,
          commandId: receipt.commandId,
          ...(receipt.traceId === undefined ? {} : { traceId: receipt.traceId }),
        },
      };
    }
    const completion = await options.service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      return { kind: "failure", error: completion.error, disposition: "remove-immediately" };
    }
    if (readiness !== undefined) {
      const acknowledgement = await dispatchAndWait(options, {
        type: "session.acknowledgeTurn",
        payload: readiness,
      });
      if (acknowledgement.kind !== "success") {
        return acknowledgement;
      }
    }
    const onFocusSuccess = focusTarget?.onFocusSuccess ?? options.onFocusSuccess;
    await onFocusSuccess?.();
    return { kind: "success" };
  } catch (error: unknown) {
    return executionFailure(error, options.clientLabel);
  }
}

async function dispatchAndWait(
  options: ObserverActivationCapabilitiesOptions,
  command: StationCommand,
): Promise<DashboardExecutionResult> {
  try {
    const receipt = await options.service.dispatch(command);
    if (!receipt.accepted) {
      return rejectedExecution(command.type, receipt.error);
    }
    const completion = await options.service.waitForCommandCompletion(receipt.commandId);
    return completion.status === "succeeded"
      ? { kind: "success" }
      : { kind: "failure", error: completion.error, disposition: "remove-immediately" };
  } catch (error: unknown) {
    return executionFailure(error, options.clientLabel);
  }
}

function rejectedExecution(type: string, error: SafeError | undefined): DashboardExecutionResult {
  return {
    kind: "failure",
    disposition: "remove-immediately",
    error:
      error ??
      ({
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: `${type} was rejected.`,
      } satisfies SafeError),
  };
}

function executionFailure(error: unknown, clientLabel = "TUI"): DashboardExecutionResult {
  return {
    kind: "failure",
    error: toSafeError(error, { clientLabel }),
    disposition: "remove-immediately",
  };
}

async function resolveConfiguredFocusTarget(
  options: ObserverActivationCapabilitiesOptions,
): Promise<DashboardFocusTarget | undefined> {
  if (options.resolveFocusTarget !== undefined) {
    const resolved = await options.resolveFocusTarget();
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return options.focusOrigin === undefined ? undefined : { origin: options.focusOrigin };
}

function withCommandFocusOrigin<
  T extends Extract<StationCommand, { type: "session.startAgent" | "session.resumeAgent" }>,
>(command: T, origin: TerminalFocusOrigin): T {
  return {
    ...command,
    payload: {
      ...command.payload,
      terminal: {
        ...(command.payload.terminal ?? {}),
        focus: true,
        origin,
      },
    },
  };
}

function sessionIdForStartedWorktree(
  snapshot: StationSnapshot | undefined,
  worktreeId: string,
): string | undefined {
  const row = snapshot?.rows.find((candidate) => candidate.id === worktreeId);
  if (row === undefined || !worktreeHasLiveAgent(row)) {
    return undefined;
  }
  if (row.agent?.sessionId !== undefined) {
    return row.agent.sessionId;
  }
  return snapshot?.sessions.find(
    (candidate) => candidate.origin === "station" && candidate.worktreeId === worktreeId,
  )?.id;
}

function readinessForSession(
  snapshot: StationSnapshot | undefined,
  sessionId: string,
): { sessionId: string; token: string } | undefined {
  const agent = snapshot?.rows.find((row) => row.agent?.sessionId === sessionId)?.agent;
  if (
    agent?.state !== "idle" ||
    agent.sessionId === undefined ||
    agent.turnReadiness?.state !== "ready_to_read"
  ) {
    return undefined;
  }
  return { sessionId: agent.sessionId, token: agent.turnReadiness.token };
}
