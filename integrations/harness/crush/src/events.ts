// Crush PreToolUse hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md
// STATION ingress flow: docs/harness-ingress.md. Native stdin payload {event,session_id,cwd,tool_name,tool_input}
// is parsed STRICT here; upstream field drift breaks ingestion.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  RawHarnessEvent,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import { observedPathIsSameOrInside, sameObservedPath } from "@station/contracts";
import { z } from "zod";

export type CrushHookPayload = z.infer<typeof CrushHookPayloadSchema>;

const nonEmptyStringSchema = z.string().min(1);

export const CrushHookPayloadSchema = z
  .object({
    event: z.literal("PreToolUse"),
    session_id: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
    tool_name: nonEmptyStringSchema.optional(),
    tool_input: z.unknown().optional(),
    station_project_id: nonEmptyStringSchema.optional(),
    station_worktree_id: nonEmptyStringSchema.optional(),
    station_worktree_path: nonEmptyStringSchema.optional(),
    station_session_id: nonEmptyStringSchema.optional(),
    station_terminal_provider: nonEmptyStringSchema.optional(),
    station_terminal_target_id: nonEmptyStringSchema.optional(),
  })
  .strict();

export function parseCrushHookPayload(input: unknown): CrushHookPayload {
  const result = CrushHookPayloadSchema.safeParse(input);
  if (!result.success) {
    throw crushHarnessError(
      "HARNESS_CRUSH_EVENT_INVALID",
      "Crush hook event did not match the supported PreToolUse schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeCrushRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parseCrushHookPayload(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateCrushEvent(event, context);
  const observation: HarnessEventObservation = {
    provider: "crush",
    rawEventType: event.event,
    observedAt,
    providerData: providerDataFromCrushEvent(event),
  };
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
  if (correlation.cwd !== undefined) observation.cwd = correlation.cwd;
  return [observation];
}

function providerDataFromCrushEvent(event: CrushHookPayload): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    hookEventName: event.event,
  };
  if (event.session_id !== undefined) providerData.crushSessionId = event.session_id;
  if (event.cwd !== undefined) providerData.cwd = event.cwd;
  if (event.tool_name !== undefined) providerData.toolName = event.tool_name;
  if (event.station_project_id !== undefined)
    providerData.stationProjectId = event.station_project_id;
  if (event.station_worktree_id !== undefined)
    providerData.stationWorktreeId = event.station_worktree_id;
  if (event.station_worktree_path !== undefined) {
    providerData.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_session_id !== undefined)
    providerData.stationSessionId = event.station_session_id;
  if (event.station_terminal_provider !== undefined) {
    providerData.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    providerData.stationTerminalTargetId = event.station_terminal_target_id;
  }
  return providerData;
}

function correlateCrushEvent(
  event: CrushHookPayload,
  context: HarnessEventContext,
): {
  projectId?: string;
  sessionId?: string;
  worktreeId?: string;
  terminalTargetId?: string;
  harnessRunId?: string;
  nativeSessionId?: string;
  cwd?: string;
} {
  const cwd = event.cwd ?? event.station_worktree_path;
  const terminal =
    terminalForId(event.station_terminal_target_id, context.terminalTargets) ??
    terminalForCwd(cwd, context.terminalTargets);
  const worktree =
    worktreeForId(event.station_worktree_id, context.worktrees) ??
    worktreeForPath(event.station_worktree_path, context.worktrees) ??
    worktreeForCwd(cwd, context.worktrees);
  const result: {
    projectId?: string;
    sessionId?: string;
    worktreeId?: string;
    terminalTargetId?: string;
    harnessRunId?: string;
    nativeSessionId?: string;
    cwd?: string;
  } = {};
  if (event.station_project_id !== undefined) {
    result.projectId = event.station_project_id;
  } else if (terminal?.projectId !== undefined) {
    result.projectId = terminal.projectId;
  } else if (worktree?.projectId !== undefined) {
    result.projectId = worktree.projectId;
  }
  if (event.station_session_id !== undefined) {
    result.sessionId = event.station_session_id;
  } else if (terminal?.sessionId !== undefined) {
    result.sessionId = terminal.sessionId;
  }
  if (event.station_worktree_id !== undefined) {
    result.worktreeId = event.station_worktree_id;
  } else if (terminal?.worktreeId !== undefined) {
    result.worktreeId = terminal.worktreeId;
  } else if (worktree !== undefined) {
    result.worktreeId = worktree.id;
  }
  if (event.station_terminal_target_id !== undefined) {
    result.terminalTargetId = event.station_terminal_target_id;
    result.harnessRunId = `crush:${event.station_terminal_target_id}`;
  } else if (terminal?.harnessRunId !== undefined) {
    result.terminalTargetId = terminal.id;
    result.harnessRunId = terminal.harnessRunId;
  } else if (terminal !== undefined) {
    result.terminalTargetId = terminal.id;
    result.harnessRunId = `crush:${terminal.id}`;
  }
  if (event.session_id !== undefined) result.nativeSessionId = event.session_id;
  if (cwd !== undefined) result.cwd = cwd;
  return result;
}

function terminalForId(
  terminalTargetId: string | undefined,
  targets: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  if (terminalTargetId === undefined) {
    return undefined;
  }
  return targets.find((target) => target.id === terminalTargetId);
}

function terminalForCwd(
  cwd: string | undefined,
  targets: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  return (
    targets.find((target) => target.cwd !== undefined && sameObservedPath(target.cwd, cwd)) ??
    targets.find(
      (target) => target.cwd !== undefined && observedPathIsSameOrInside(cwd, target.cwd),
    )
  );
}

function worktreeForId(
  worktreeId: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (worktreeId === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => worktree.id === worktreeId);
}

function worktreeForPath(
  worktreePath: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (worktreePath === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => sameObservedPath(worktree.path, worktreePath));
}

function worktreeForCwd(
  cwd: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => observedPathIsSameOrInside(cwd, worktree.path));
}

function crushHarnessError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(`${code}: ${message}`, { cause }), {
    tag: "HarnessProviderError",
    code,
    provider: "crush",
  });
}
