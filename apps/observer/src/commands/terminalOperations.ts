import type {
  BuildHarnessLaunchRequest,
  HarnessProvider,
  HarnessResumeOptions,
  ProviderProjectConfig,
  SafeError,
  SessionView,
  TerminalFocusOperationalEvent,
  TerminalFocusOrigin,
  TerminalFocusResolutionEvidence,
  TerminalProvider,
  TerminalState,
  TerminalTargetObservation,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import { terminalTargetObservationFromBinding } from "@station/contracts";
import { type RuntimeClock, systemClock, toIsoTimestamp } from "@station/runtime";
import { toSafeError } from "../diagnostics/errors.js";
import type { StationLogger, StationOperationalEventRecord } from "../stationLogger.js";
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

/** Opens and launches through provider ports, repeating preflight immediately before mutation. */
export async function ensureAgentWorkspace(
  input: {
    terminal: TerminalProvider;
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
  } & TerminalOperationRuntime,
): Promise<void> {
  throwIfAborted(input.context.signal);
  await input.launchPreflight(input.harness.id, input.context.signal);
  const runtime = operationRuntime(input);
  let opened: Awaited<ReturnType<TerminalProvider["openWorkspace"]>> | undefined;

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
      () =>
        input.terminal.openWorkspace({
          project: input.project,
          worktree: input.worktree,
          harness: input.harness.id,
          layout: input.layout,
          sessionId: input.sessionId,
        }),
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
    if (opened !== undefined) {
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
}

/**
 * USE CASE
 *
 * Resolves fresh provider-owned target evidence from product identity, focuses the selected
 * target with request-local origin context, and retains one bounded decision record.
 */
export async function focusTerminal(
  input: {
    terminal: TerminalProvider;
    subject: TerminalTargetSubject;
    origin?: TerminalFocusOrigin | undefined;
  } & TerminalOperationRuntime,
): Promise<void> {
  let resolution: TerminalTargetResolution | undefined;
  try {
    resolution = await resolveTerminalTarget(input);
    if (resolution.kind !== "selected") {
      throw terminalTargetResolutionError(input.terminal.id, input.subject, resolution);
    }
    const selectedResolution = resolution;
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
      () => input.terminal.focusTarget(selectedResolution.target.id, focusContext(input.origin)),
    );
    await recordTerminalFocusDecision(input, {
      outcome: "focused",
      resolution: selectedResolution,
    });
  } catch (error) {
    const safeError = toSafeError(
      error,
      {
        tag: "TerminalProviderError",
        code: "TERMINAL_FOCUS_FAILED",
        message: "The terminal provider failed to focus the target.",
        provider: input.terminal.id,
      },
      { commandId: input.context.commandId, traceId: input.context.trace.traceId },
    );
    const failedDecision: TerminalFocusDecisionResult = {
      outcome: "failed",
      errorCode: safeError.code,
    };
    if (resolution !== undefined) failedDecision.resolution = resolution;
    await recordTerminalFocusDecision(input, failedDecision);
    throw safeError;
  }
}

/** Resolves and closes one provider-owned target from product session/worktree identity. */
export async function closeTerminal(
  input: {
    terminal: TerminalProvider;
    subject: TerminalTargetSubject;
  } & TerminalOperationRuntime,
): Promise<void> {
  try {
    const resolution = await resolveTerminalTarget(input);
    if (resolution.kind !== "selected") {
      throw terminalTargetResolutionError(input.terminal.id, input.subject, resolution);
    }
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
      () => input.terminal.closeTarget(resolution.target.id),
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
  clock?: RuntimeClock | undefined;
}): Promise<TerminalTargetResolution> {
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
    .map((target) => rankedTarget(target, input.subject))
    .filter((candidate): candidate is RankedTarget => candidate !== undefined)
    .sort((left, right) =>
      left.identityRank === right.identityRank
        ? left.stateRank - right.stateRank
        : left.identityRank - right.identityRank,
    );
  const selected = ranked[0];
  if (selected !== undefined) {
    return {
      kind: "selected",
      target: selected.target,
      selectionBasis: selected.selectionBasis,
      totalTargetCount: targets.length,
      matchingTargetCount: matching.length,
    };
  }
  if (matching.some((target) => target.state === "stale")) {
    return {
      kind: "stale",
      totalTargetCount: targets.length,
      matchingTargetCount: matching.length,
    };
  }
  return {
    kind: "missing",
    totalTargetCount: targets.length,
    matchingTargetCount: matching.length,
  };
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
  selectionBasis: TerminalTargetSelectionBasis;
};

type TerminalTargetSelectionBasis =
  | "session-main-agent"
  | "session"
  | "worktree-main-agent"
  | "worktree"
  | "cwd-fallback";

type TerminalTargetResolution =
  | {
      kind: "selected";
      target: TerminalTargetObservation;
      selectionBasis: TerminalTargetSelectionBasis;
      totalTargetCount: number;
      matchingTargetCount: number;
    }
  | {
      kind: "stale" | "missing";
      totalTargetCount: number;
      matchingTargetCount: number;
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
): RankedTarget | undefined {
  const stateRank = targetStateRank(target.state);
  const identity = targetIdentity(target, subject);
  return stateRank === undefined || identity === undefined
    ? undefined
    : {
        target,
        identityRank: identity.rank,
        stateRank,
        selectionBasis: identity.basis,
      };
}

function targetIdentity(
  target: TerminalTargetObservation,
  subject: TerminalTargetSubject,
): { rank: number; basis: TerminalTargetSelectionBasis } | undefined {
  const mainAgent = target.harnessBinding?.role === "main-agent";
  if (subject.sessionId !== undefined && target.sessionId === subject.sessionId && mainAgent) {
    return { rank: 0, basis: "session-main-agent" };
  }
  if (subject.sessionId !== undefined && target.sessionId === subject.sessionId) {
    return { rank: 1, basis: "session" };
  }
  if (subject.worktreeId !== undefined && target.worktreeId === subject.worktreeId && mainAgent) {
    return { rank: 2, basis: "worktree-main-agent" };
  }
  if (subject.worktreeId !== undefined && target.worktreeId === subject.worktreeId) {
    return { rank: 3, basis: "worktree" };
  }
  if (target.cwd !== undefined) return { rank: 4, basis: "cwd-fallback" };
  return undefined;
}

function targetStateRank(state: TerminalState): number | undefined {
  switch (state) {
    case "open":
      return 0;
    case "detached":
      return 1;
    case "unknown":
      return 2;
    case "none":
    case "stale":
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

function terminalTargetResolutionError(
  provider: string,
  subject: TerminalTargetSubject,
  resolution: Exclude<TerminalTargetResolution, { kind: "selected" }>,
): SafeError {
  return resolution.kind === "stale"
    ? terminalTargetStaleError(provider, subject)
    : terminalTargetMissingError(provider, subject);
}

type TerminalFocusDecisionResult =
  | {
      outcome: "focused";
      resolution: Extract<TerminalTargetResolution, { kind: "selected" }>;
    }
  | {
      outcome: "failed";
      errorCode: string;
      resolution?: TerminalTargetResolution | undefined;
    };

async function recordTerminalFocusDecision(
  input: {
    terminal: TerminalProvider;
    subject: TerminalTargetSubject;
    origin?: TerminalFocusOrigin | undefined;
  } & TerminalOperationRuntime,
  result: TerminalFocusDecisionResult,
): Promise<void> {
  if (input.logger === undefined) return;
  let decision: TerminalFocusOperationalEvent["decision"];
  if (result.outcome === "focused") {
    decision = {
      outcome: "focused",
      hasOriginClientId: input.origin?.clientId !== undefined,
      resolution: terminalFocusResolutionEvidence(result.resolution),
    };
  } else {
    const failedDecision: Extract<
      TerminalFocusOperationalEvent["decision"],
      { outcome: "failed" }
    > = {
      outcome: "failed",
      hasOriginClientId: input.origin?.clientId !== undefined,
      errorCode: result.errorCode,
    };
    if (result.resolution !== undefined) {
      failedDecision.resolution = terminalFocusResolutionEvidence(result.resolution);
    }
    decision = failedDecision;
  }
  if (input.origin?.provider !== undefined) decision.originProvider = input.origin.provider;
  const record: StationOperationalEventRecord = {
    level: "info",
    commandId: input.context.commandId,
    traceId: input.context.trace.traceId,
    provider: input.terminal.id,
    operationalEvent: {
      kind: "terminal.focus.decision",
      decision,
    },
  };
  if (input.subject.projectId !== undefined) record.projectId = input.subject.projectId;
  if (input.subject.worktreeId !== undefined) record.worktreeId = input.subject.worktreeId;
  if (input.subject.sessionId !== undefined) record.sessionId = input.subject.sessionId;
  await input.logger.recordOperationalEvent(record).catch(() => undefined);
}

function terminalFocusResolutionEvidence(
  resolution: Extract<TerminalTargetResolution, { kind: "selected" }>,
): Extract<TerminalFocusResolutionEvidence, { kind: "selected" }>;
function terminalFocusResolutionEvidence(
  resolution: TerminalTargetResolution,
): TerminalFocusResolutionEvidence;
function terminalFocusResolutionEvidence(
  resolution: TerminalTargetResolution,
): TerminalFocusResolutionEvidence {
  if (resolution.kind !== "selected") {
    return {
      kind: resolution.kind,
      totalTargetCount: resolution.totalTargetCount,
      matchingTargetCount: resolution.matchingTargetCount,
    };
  }
  return {
    kind: "selected",
    totalTargetCount: resolution.totalTargetCount,
    matchingTargetCount: resolution.matchingTargetCount,
    targetId: resolution.target.id,
    targetState: resolution.target.state,
    selectionBasis: resolution.selectionBasis,
  };
}

function assignSubject(error: SafeError, subject: TerminalTargetSubject): void {
  if (subject.projectId !== undefined) error.projectId = subject.projectId;
  if (subject.worktreeId !== undefined) error.worktreeId = subject.worktreeId;
  if (subject.sessionId !== undefined) error.sessionId = subject.sessionId;
}
