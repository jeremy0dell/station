import type {
  BuildHarnessLaunchRequest,
  HarnessProvider,
  HarnessResumeOptions,
  OpenPlacedWorkspaceResult,
  OpenWorkspaceResult,
  ProviderProjectConfig,
  ResolvedTerminalPlacement,
  SafeError,
  SessionView,
  TerminalFocusOrigin,
  TerminalPlacementPort,
  TerminalPlacementRequest,
  TerminalProvider,
  TerminalState,
  TerminalTargetObservation,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import { terminalTargetObservationFromBinding } from "@station/contracts";
import {
  type RuntimeClock,
  safeErrorFromUnknown,
  systemClock,
  toIsoTimestamp,
} from "@station/runtime";
import { toSafeError } from "../diagnostics/errors.js";
import type { StationLogger } from "../stationLogger.js";
import { throwIfAborted } from "./cancellation.js";
import type { HarnessLaunchPreflight } from "./harnessLaunchPreflight.js";
import type { CommandHandlerContext } from "./queue.js";
import { launchHarnessInTerminal, runProviderMutation } from "./session/shared.js";

export type TerminalTargetSubject = {
  projectId?: string | undefined;
  worktreeId?: string | undefined;
  sessionId?: string | undefined;
};

type TerminalOperationRuntime = {
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
};

type HarnessLaunchOptions = {
  mode?: "interactive" | "exec" | undefined;
  profile?: string | undefined;
  approvalPolicy?: string | undefined;
  sandboxMode?: string | undefined;
};

type EnsureAgentWorkspaceInput = {
  terminal: TerminalProvider;
  placementPort?: TerminalPlacementPort | undefined;
  placement?: TerminalPlacementRequest | undefined;
  harness: HarnessProvider;
  launchPreflight: HarnessLaunchPreflight;
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  sessionId: string;
  layout: string;
  harnessOptions?: HarnessLaunchOptions | undefined;
  focus?: boolean | undefined;
  origin?: TerminalFocusOrigin | undefined;
  initialPrompt?: string | undefined;
  resume?: HarnessResumeOptions | undefined;
} & TerminalOperationRuntime;

/**
 * USE CASE
 *
 * Opens and launches an agent workspace. When placement is supplied, the terminal
 * adapter alone revalidates the authority immediately before target mutation;
 * failures close only the target opened by this invocation and never fall back
 * to a current, recent, or focused terminal. Successful explicit placement
 * returns the provider's resolved destination proof.
 */
export function ensureAgentWorkspace(
  input: EnsureAgentWorkspaceInput & {
    placementPort: TerminalPlacementPort;
    placement: TerminalPlacementRequest;
  },
): Promise<ResolvedTerminalPlacement>;
export function ensureAgentWorkspace(
  input: EnsureAgentWorkspaceInput,
): Promise<ResolvedTerminalPlacement | undefined>;
export async function ensureAgentWorkspace(
  input: EnsureAgentWorkspaceInput,
): Promise<ResolvedTerminalPlacement | undefined> {
  throwIfAborted(input.context.signal);
  await input.launchPreflight(input.harness.id, {
    signal: input.context.signal,
    beginMutation: input.context.beginCommit,
  });
  const runtime = operationRuntime(input);
  let opened: OpenWorkspaceResult | OpenPlacedWorkspaceResult | undefined;
  let placedOpened: OpenPlacedWorkspaceResult | undefined;

  try {
    opened = await runProviderMutation(
      {
        ...runtime,
        operation: `provider.${input.terminal.id}.openWorkspace`,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_OPEN_FAILED",
          message: "The terminal provider failed to open the session workspace.",
          provider: input.terminal.id,
        },
      },
      async () => {
        const request = {
          project: input.project,
          worktree: input.worktree,
          harness: input.harness.id,
          layout: input.layout,
          sessionId: input.sessionId,
        };
        if (input.placement === undefined) {
          return input.terminal.openWorkspace(request);
        }
        if (input.placementPort === undefined) {
          throw {
            tag: "TerminalProviderError",
            code: "TERMINAL_PLACEMENT_UNSUPPORTED",
            message: "The terminal provider cannot open a workspace with explicit placement.",
            provider: input.terminal.id,
          } satisfies SafeError;
        }
        // The adapter validates its authority immediately before this mutation.
        const result = await input.placementPort.openPlacedWorkspace({
          ...request,
          placement: input.placement,
        });
        placedOpened = result;
        return result;
      },
    );
    throwIfAborted(input.context.signal);

    const terminalTarget = terminalTargetObservationFromBinding({
      binding: opened.target,
      worktree: input.worktree,
      observedAt: timestamp(input.clock),
    });
    const launchPlan = await runProviderMutation(
      {
        ...runtime,
        operation: `provider.${input.harness.id}.buildLaunch`,
        fallback: {
          tag: "HarnessProviderError",
          code: "HARNESS_BUILD_LAUNCH_FAILED",
          message: "The harness provider failed to build a launch plan.",
          provider: input.harness.id,
        },
      },
      () => input.harness.buildLaunch(buildLaunchRequest(input, terminalTarget)),
    );
    throwIfAborted(input.context.signal);

    await launchHarnessInTerminal({
      ...runtime,
      terminal: input.terminal,
      request: {
        project: input.project,
        worktree: input.worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        launchPlan,
      },
    });

    if (input.focus === true) {
      await focusTargetBestEffort({
        ...input,
        targetId: opened.target.targetId,
      });
    }
  } catch (error) {
    if (placedOpened !== undefined && input.placementPort !== undefined) {
      await releasePlacedTargetOrThrow({
        ...input,
        placementPort: input.placementPort,
        opened: placedOpened,
      });
    } else if (opened !== undefined) {
      await closeOpenedTargetBestEffort({
        ...input,
        targetId: opened.target.targetId,
      });
    }
    throw toSafeError(
      error,
      {
        tag: "TerminalIntentRunnerError",
        code: "TERMINAL_INTENT_FAILED",
        message: "The terminal intent runner failed.",
      },
      { commandId: input.context.commandId },
    );
  }
  return placedOpened?.placement;
}

export function commandPlacementResult(
  requested: TerminalPlacementRequest,
  resolved: ResolvedTerminalPlacement,
):
  | {
      requestedPlacement: "sibling";
      resolvedPlacement: Omit<Extract<ResolvedTerminalPlacement, { intent: "sibling" }>, "intent">;
    }
  | {
      requestedPlacement: "detached";
      resolvedPlacement: Omit<Extract<ResolvedTerminalPlacement, { intent: "detached" }>, "intent">;
    } {
  if (requested.intent !== resolved.intent) {
    throw {
      tag: "TerminalProviderError",
      code: "TERMINAL_PLACEMENT_RESULT_MISMATCH",
      message: "The terminal provider resolved a different placement intent than requested.",
      provider: resolved.provider,
    } satisfies SafeError;
  }
  if (resolved.intent === "sibling") {
    return {
      requestedPlacement: "sibling",
      resolvedPlacement: {
        provider: resolved.provider,
        targetId: resolved.targetId,
        generation: resolved.generation,
        presentation: resolved.presentation,
      },
    };
  }
  return {
    requestedPlacement: "detached",
    resolvedPlacement: {
      provider: resolved.provider,
      targetId: resolved.targetId,
      generation: resolved.generation,
      presentation: resolved.presentation,
    },
  };
}

async function releasePlacedTargetOrThrow(
  input: {
    placementPort: TerminalPlacementPort;
    opened: OpenPlacedWorkspaceResult;
    sessionId: string;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.placementPort.id}.releasePlacedTarget.cleanup`,
        clock: input.clock,
        trace: input.context.trace,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_CLEANUP_UNCERTAIN",
          message: "The terminal provider could not prove placed-target cleanup.",
          provider: input.placementPort.id,
        },
      },
      () =>
        input.placementPort.releasePlacedTarget({
          targetId: input.opened.target.targetId,
          sessionId: input.sessionId,
          generation: input.opened.placement.generation,
          bindingToken: input.opened.bindingToken,
        }),
    );
  } catch (error) {
    const normalized = safeErrorFromUnknown(error, {
      tag: "TerminalProviderError",
      code: "TERMINAL_CLEANUP_UNCERTAIN",
      message: "The terminal provider could not prove placed-target cleanup.",
      provider: input.placementPort.id,
    });
    await input.logger?.warn("Placed terminal cleanup is uncertain; session state was retained.", {
      targetId: input.opened.target.targetId,
      terminalProvider: input.placementPort.id,
      traceId: input.context.trace.traceId,
      error: normalized,
    });
    throw {
      ...normalized,
      tag: "TerminalProviderError",
      code: "TERMINAL_CLEANUP_UNCERTAIN",
      message: "The terminal provider could not prove placed-target cleanup.",
      provider: input.placementPort.id,
    } satisfies SafeError;
  }
}

/** Resolves and focuses one provider-owned target from product session/worktree identity. */
export async function focusTerminal(
  input: {
    terminal: TerminalProvider;
    subject: TerminalTargetSubject;
    origin?: TerminalFocusOrigin | undefined;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    const target = await resolveTerminalTarget({ ...input, operation: "focus" });
    await runProviderMutation(
      {
        ...operationRuntime(input),
        operation: `provider.${input.terminal.id}.focusTarget`,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_FOCUS_FAILED",
          message: "The terminal provider failed to focus the target.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.focusTarget(target.id, focusContext(input.origin)),
    );
  } catch (error) {
    throw toSafeError(
      error,
      {
        tag: "TerminalProviderError",
        code: "TERMINAL_FOCUS_FAILED",
        message: "The terminal provider failed to focus the target.",
        provider: input.terminal.id,
      },
      { commandId: input.context.commandId },
    );
  }
}

/**
 * Resolves and closes one provider-owned target from product session/worktree
 * identity. Close may select stale provider targets so they can be retired;
 * focus remains restricted to live targets.
 */
export async function closeTerminal(
  input: {
    terminal: TerminalProvider;
    subject: TerminalTargetSubject;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    const target = await resolveTerminalTarget({ ...input, operation: "close" });
    await runProviderMutation(
      {
        ...operationRuntime(input),
        operation: `provider.${input.terminal.id}.closeTarget`,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_CLOSE_FAILED",
          message: "The terminal provider failed to close the target.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.closeTarget(target.id),
    );
  } catch (error) {
    throw toSafeError(
      error,
      {
        tag: "TerminalProviderError",
        code: "TERMINAL_CLOSE_FAILED",
        message: "The terminal provider failed to close the target.",
        provider: input.terminal.id,
      },
      { commandId: input.context.commandId },
    );
  }
}

export function terminalTargetSubjectForSession(
  session: SessionView,
  row?: WorktreeRow | undefined,
): TerminalTargetSubject {
  return {
    sessionId: session.id,
    worktreeId: row?.id ?? session.worktreeId,
    projectId: row?.projectId ?? session.projectId,
  };
}

export function terminalTargetSubjectForWorktree(row: WorktreeRow): TerminalTargetSubject {
  const subject: TerminalTargetSubject = {
    worktreeId: row.id,
    projectId: row.projectId,
  };
  if (row.agent?.sessionId !== undefined) subject.sessionId = row.agent.sessionId;
  return subject;
}

export function hasCloseableTerminalAttachment(input: {
  session?: SessionView | undefined;
  row?: WorktreeRow | undefined;
}): boolean {
  return input.session?.terminal?.closeable === true || input.row?.terminal?.closeable === true;
}

async function resolveTerminalTarget(input: {
  terminal: TerminalProvider;
  subject: TerminalTargetSubject;
  context: CommandHandlerContext;
  operation: "focus" | "close";
  clock?: RuntimeClock | undefined;
}): Promise<TerminalTargetObservation> {
  const targets = await runProviderMutation(
    {
      ...operationRuntime(input),
      operation: `provider.${input.terminal.id}.listTargets`,
      fallback: {
        tag: "TerminalProviderError",
        code: "TERMINAL_LIST_FAILED",
        message: "The terminal provider failed to list targets.",
        provider: input.terminal.id,
      },
    },
    () => input.terminal.listTargets(),
  );

  const matching = targets.filter((target) =>
    targetMatchesSubject({
      target,
      terminalProvider: input.terminal.id,
      subject: input.subject,
    }),
  );
  const ranked = matching
    .map((target) => rankedTarget(target, input.subject, input.operation))
    .filter((candidate): candidate is RankedTarget => candidate !== undefined)
    .sort((left, right) =>
      left.identityRank === right.identityRank
        ? left.stateRank - right.stateRank
        : left.identityRank - right.identityRank,
    );
  const selected = ranked[0]?.target;
  if (selected !== undefined) return selected;
  if (matching.some((target) => target.state === "stale")) {
    throw terminalTargetStaleError(input.terminal.id, input.subject);
  }
  throw terminalTargetMissingError(input.terminal.id, input.subject);
}

async function closeOpenedTargetBestEffort(
  input: {
    terminal: TerminalProvider;
    targetId: string;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    await runProviderMutation(
      {
        operation: `provider.${input.terminal.id}.closeTarget.cleanup`,
        clock: input.clock,
        signal: input.context.signal,
        trace: input.context.trace,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_CLEANUP_CLOSE_FAILED",
          message: "The terminal provider failed to close a target during cleanup.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.closeTarget(input.targetId),
    );
  } catch (error) {
    await input.logger?.warn("Terminal launch cleanup failed to close terminal target.", {
      targetId: input.targetId,
      terminalProvider: input.terminal.id,
      traceId: input.context.trace.traceId,
      error,
    });
  }
}

async function focusTargetBestEffort(
  input: {
    terminal: TerminalProvider;
    targetId: string;
    origin?: TerminalFocusOrigin | undefined;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    await runProviderMutation(
      {
        ...operationRuntime(input),
        operation: `provider.${input.terminal.id}.focusTarget`,
        fallback: {
          tag: "TerminalProviderError",
          code: "TERMINAL_FOCUS_FAILED",
          message: "The terminal provider failed to focus the session target.",
          provider: input.terminal.id,
        },
      },
      () => input.terminal.focusTarget(input.targetId, focusContext(input.origin)),
    );
  } catch (error) {
    await input.logger?.warn("Terminal focus failed after session launch.", {
      targetId: input.targetId,
      terminalProvider: input.terminal.id,
      traceId: input.context.trace.traceId,
      error,
    });
  }
}

function buildLaunchRequest(
  input: {
    project: ProviderProjectConfig;
    worktree: WorktreeObservation;
    sessionId: string;
    harnessOptions?: HarnessLaunchOptions | undefined;
    initialPrompt?: string | undefined;
    resume?: HarnessResumeOptions | undefined;
  },
  terminalTarget: TerminalTargetObservation,
): BuildHarnessLaunchRequest {
  const request: BuildHarnessLaunchRequest = {
    project: input.project,
    worktree: input.worktree,
    terminalTarget,
    sessionId: input.sessionId,
  };
  if (input.harnessOptions?.mode !== undefined) request.mode = input.harnessOptions.mode;
  if (input.initialPrompt !== undefined) request.initialPrompt = input.initialPrompt;
  if (input.harnessOptions?.profile !== undefined) request.profile = input.harnessOptions.profile;
  if (input.harnessOptions?.approvalPolicy !== undefined) {
    request.approvalPolicy = input.harnessOptions.approvalPolicy;
  }
  if (input.harnessOptions?.sandboxMode !== undefined) {
    request.sandboxMode = input.harnessOptions.sandboxMode;
  }
  if (input.resume !== undefined) request.resume = input.resume;
  return request;
}

function operationRuntime(input: {
  context: CommandHandlerContext;
  clock?: RuntimeClock | undefined;
}) {
  return {
    clock: input.clock,
    signal: input.context.signal,
    trace: input.context.trace,
  };
}

function focusContext(
  origin: TerminalFocusOrigin | undefined,
): { origin?: TerminalFocusOrigin } | undefined {
  return origin === undefined ? undefined : { origin };
}

function timestamp(clock: RuntimeClock | undefined): string {
  return toIsoTimestamp((clock ?? systemClock).now());
}

type RankedTarget = {
  target: TerminalTargetObservation;
  identityRank: number;
  stateRank: number;
};

function targetMatchesSubject(input: {
  target: TerminalTargetObservation;
  terminalProvider: string;
  subject: TerminalTargetSubject;
}): boolean {
  if (input.target.provider !== input.terminalProvider) return false;
  if (
    input.subject.projectId !== undefined &&
    input.target.projectId !== undefined &&
    input.target.projectId !== input.subject.projectId
  ) {
    return false;
  }
  if (input.subject.sessionId !== undefined && input.target.sessionId === input.subject.sessionId) {
    return true;
  }
  return (
    input.subject.worktreeId !== undefined && input.target.worktreeId === input.subject.worktreeId
  );
}

function rankedTarget(
  target: TerminalTargetObservation,
  subject: TerminalTargetSubject,
  operation: "focus" | "close",
): RankedTarget | undefined {
  const stateRank = targetStateRank(target.state, operation);
  const identityRank = targetIdentityRank(target, subject);
  return stateRank === undefined || identityRank === undefined
    ? undefined
    : { target, identityRank, stateRank };
}

function targetIdentityRank(
  target: TerminalTargetObservation,
  subject: TerminalTargetSubject,
): number | undefined {
  const mainAgent = target.harnessBinding?.role === "main-agent";
  if (subject.sessionId !== undefined && target.sessionId === subject.sessionId && mainAgent)
    return 0;
  if (subject.sessionId !== undefined && target.sessionId === subject.sessionId) return 1;
  if (subject.worktreeId !== undefined && target.worktreeId === subject.worktreeId && mainAgent) {
    return 2;
  }
  if (subject.worktreeId !== undefined && target.worktreeId === subject.worktreeId) return 3;
  if (target.cwd !== undefined) return 4;
  return undefined;
}

function targetStateRank(state: TerminalState, operation: "focus" | "close"): number | undefined {
  switch (state) {
    case "open":
      return 0;
    case "detached":
      return 1;
    case "unknown":
      return 2;
    case "stale":
      return operation === "close" ? 3 : undefined;
    case "none":
      return undefined;
  }
}

function terminalTargetMissingError(provider: string, subject: TerminalTargetSubject): SafeError {
  const error: SafeError = {
    tag: "TerminalProviderError",
    code: "TERMINAL_TARGET_MISSING",
    message:
      subject.sessionId === undefined
        ? "No terminal is open for this worktree."
        : "No terminal is open for this session.",
    hint:
      subject.sessionId === undefined
        ? "Start an agent or open this worktree from station before focusing it."
        : "Refresh the dashboard and retry.",
    provider,
  };
  assignSubject(error, subject);
  return error;
}

function terminalTargetStaleError(provider: string, subject: TerminalTargetSubject): SafeError {
  const error: SafeError = {
    tag: "TerminalProviderError",
    code: "TERMINAL_TARGET_STALE",
    message: "Only stale terminal targets match the requested session or worktree.",
    hint: "Refresh the dashboard or reopen the worktree before retrying.",
    provider,
  };
  assignSubject(error, subject);
  return error;
}

function assignSubject(error: SafeError, subject: TerminalTargetSubject): void {
  if (subject.projectId !== undefined) error.projectId = subject.projectId;
  if (subject.worktreeId !== undefined) error.worktreeId = subject.worktreeId;
  if (subject.sessionId !== undefined) error.sessionId = subject.sessionId;
}
