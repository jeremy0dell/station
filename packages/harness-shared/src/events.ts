import type {
  HarnessEventContext,
  HarnessEventDiagnostics,
  HarnessEventObservation,
  HarnessEventReport,
  ProviderId,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { observedPathIsSameOrInside, sameObservedPath } from "@station/contracts";

export type StationHookIdentityLike = {
  station_project_id?: string | undefined;
  station_worktree_id?: string | undefined;
  station_worktree_path?: string | undefined;
  station_session_id?: string | undefined;
  station_terminal_target_id?: string | undefined;
};

export type HarnessEventDiagnosticsInput = {
  payloadBytes?: number | null;
  compactedBytes?: number | null;
  compacted?: boolean;
  truncated?: boolean;
  omittedFieldNames?: string[];
};

export type HarnessEventCorrelation = {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  worktreeId?: string | undefined;
  terminalTargetId?: string | undefined;
  harnessRunId?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeSessionFile?: string | undefined;
  cwd?: string | undefined;
  pid?: number | undefined;
};

export function harnessEventDiagnostics(
  rawEventType: string,
  input: HarnessEventDiagnosticsInput | undefined,
): HarnessEventDiagnostics {
  const diagnostics: HarnessEventDiagnostics = { rawEventType };
  if (typeof input?.payloadBytes === "number") diagnostics.payloadBytes = input.payloadBytes;
  if (typeof input?.compactedBytes === "number") diagnostics.compactedBytes = input.compactedBytes;
  if (input?.compacted !== undefined) diagnostics.compacted = input.compacted;
  if (input?.truncated !== undefined) diagnostics.truncated = input.truncated;
  if (input?.omittedFieldNames !== undefined && input.omittedFieldNames.length > 0) {
    diagnostics.omittedFieldNames = input.omittedFieldNames;
  }
  return diagnostics;
}

export function reportCorrelation(
  input: HarnessEventCorrelation,
): HarnessEventReport["correlation"] {
  const correlation: NonNullable<HarnessEventReport["correlation"]> = {};
  if (input.harnessRunId !== undefined) correlation.harnessRunId = input.harnessRunId;
  if (input.sessionId !== undefined) correlation.sessionId = input.sessionId;
  if (input.worktreeId !== undefined) correlation.worktreeId = input.worktreeId;
  if (input.terminalTargetId !== undefined) correlation.terminalTargetId = input.terminalTargetId;
  if (input.projectId !== undefined) correlation.projectId = input.projectId;
  if (input.nativeSessionId !== undefined) correlation.nativeSessionId = input.nativeSessionId;
  if (input.nativeSessionFile !== undefined)
    correlation.nativeSessionFile = input.nativeSessionFile;
  if (input.cwd !== undefined) correlation.cwd = input.cwd;
  if (input.pid !== undefined) correlation.pid = input.pid;
  return Object.keys(correlation).length === 0 ? undefined : correlation;
}

export function applyCorrelation(
  observation: HarnessEventObservation,
  correlation: HarnessEventCorrelation,
): void {
  if (correlation.projectId !== undefined) observation.projectId = correlation.projectId;
  if (correlation.sessionId !== undefined) observation.sessionId = correlation.sessionId;
  if (correlation.worktreeId !== undefined) observation.worktreeId = correlation.worktreeId;
  if (correlation.terminalTargetId !== undefined) {
    observation.terminalTargetId = correlation.terminalTargetId;
  }
  if (correlation.harnessRunId !== undefined) observation.harnessRunId = correlation.harnessRunId;
  if (correlation.nativeSessionId !== undefined) {
    observation.nativeSessionId = correlation.nativeSessionId;
  }
  if (correlation.nativeSessionFile !== undefined) {
    observation.nativeSessionFile = correlation.nativeSessionFile;
  }
  if (correlation.cwd !== undefined) observation.cwd = correlation.cwd;
  if (correlation.pid !== undefined) observation.pid = correlation.pid;
}

export function correlateTerminalBoundHarnessEvent(input: {
  provider: ProviderId;
  identity: StationHookIdentityLike;
  context: HarnessEventContext;
  cwd?: string | undefined;
  nativeSessionId?: string | undefined;
  nativeSessionFile?: string | undefined;
  pid?: number | undefined;
  includeProjectId?: boolean;
  includeTerminalTargetId?: boolean;
  includeCwd?: boolean;
}): HarnessEventCorrelation {
  const terminal =
    terminalForId(input.identity.station_terminal_target_id, input.context.terminalTargets) ??
    terminalForCwd(input.cwd, input.context.terminalTargets);
  const worktree =
    worktreeForId(input.identity.station_worktree_id, input.context.worktrees) ??
    worktreeForPath(input.identity.station_worktree_path, input.context.worktrees) ??
    worktreeForCwd(input.cwd, input.context.worktrees);
  const result: HarnessEventCorrelation = {};
  if (input.includeProjectId === true) {
    if (input.identity.station_project_id !== undefined) {
      result.projectId = input.identity.station_project_id;
    } else if (terminal?.projectId !== undefined) {
      result.projectId = terminal.projectId;
    } else if (worktree?.projectId !== undefined) {
      result.projectId = worktree.projectId;
    }
  }
  if (input.identity.station_session_id !== undefined) {
    result.sessionId = input.identity.station_session_id;
  } else if (terminal?.sessionId !== undefined) {
    result.sessionId = terminal.sessionId;
  }
  if (input.identity.station_worktree_id !== undefined) {
    result.worktreeId = input.identity.station_worktree_id;
  } else if (terminal?.worktreeId !== undefined) {
    result.worktreeId = terminal.worktreeId;
  } else if (worktree !== undefined) {
    result.worktreeId = worktree.id;
  }
  if (input.identity.station_terminal_target_id !== undefined) {
    if (input.includeTerminalTargetId === true) {
      result.terminalTargetId = input.identity.station_terminal_target_id;
    }
    result.harnessRunId = `${input.provider}:${input.identity.station_terminal_target_id}`;
  } else if (terminal?.harnessRunId !== undefined) {
    if (input.includeTerminalTargetId === true) result.terminalTargetId = terminal.id;
    result.harnessRunId = terminal.harnessRunId;
  } else if (terminal !== undefined) {
    if (input.includeTerminalTargetId === true) result.terminalTargetId = terminal.id;
    result.harnessRunId = `${input.provider}:${terminal.id}`;
  }
  if (input.nativeSessionId !== undefined) result.nativeSessionId = input.nativeSessionId;
  if (input.nativeSessionFile !== undefined) result.nativeSessionFile = input.nativeSessionFile;
  if (input.includeCwd === true && input.cwd !== undefined) result.cwd = input.cwd;
  if (input.pid !== undefined) result.pid = input.pid;
  return result;
}

export function terminalForId(
  terminalTargetId: string | undefined,
  targets: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  if (terminalTargetId === undefined) return undefined;
  return targets.find((target) => target.id === terminalTargetId);
}

export function terminalForCwd(
  cwd: string | undefined,
  targets: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  if (cwd === undefined) return undefined;
  return (
    targets.find((target) => target.cwd !== undefined && sameObservedPath(target.cwd, cwd)) ??
    targets.find(
      (target) => target.cwd !== undefined && observedPathIsSameOrInside(cwd, target.cwd),
    )
  );
}

export function worktreeForId(
  worktreeId: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (worktreeId === undefined) return undefined;
  return worktrees.find((worktree) => worktree.id === worktreeId);
}

export function worktreeForPath(
  worktreePath: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (worktreePath === undefined) return undefined;
  return worktrees.find((worktree) => sameObservedPath(worktree.path, worktreePath));
}

export function worktreeForCwd(
  cwd: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (cwd === undefined) return undefined;
  return (
    worktrees.find((worktree) => sameObservedPath(worktree.path, cwd)) ??
    worktrees.find((worktree) => observedPathIsSameOrInside(cwd, worktree.path))
  );
}
