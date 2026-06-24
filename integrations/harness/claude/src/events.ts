// Claude Code hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://code.claude.com/docs/en/hooks-guide
// STATION ingress flow: docs/harness-ingress.md. Keep the parsed payload shape in sync with upstream.
import type {
  HarnessEventContext,
  HarnessEventObservation,
  HarnessEventReport,
  ObservedStatus,
  RawHarnessEvent,
  TerminalTargetObservation,
  WorktreeObservation,
} from "@station/contracts";
import {
  HarnessEventReportSchema,
  observedPathIsSameOrInside,
  STATION_SCHEMA_VERSION,
  sameObservedPath,
} from "@station/contracts";
import { z } from "zod";
import { claudeHarnessError } from "./errors.js";
import { isClaudeForwardedEventType } from "./ingressRules.js";

export type ClaudeHarnessEventReportInput = {
  reportId: string;
  observedAt: string;
  payload: unknown;
  diagnostics?: {
    payloadBytes?: number | null;
    compactedBytes?: number | null;
    compacted?: boolean;
    truncated?: boolean;
    omittedFieldNames?: string[];
  };
};

export type ClaudeHookEvent = z.infer<typeof ClaudeHookEventSchema>;

const nonEmptyStringSchema = z.string().min(1);

// Claude Code adds payload fields frequently across releases; member objects deliberately
// strip unknown keys instead of rejecting them so upstream drift never breaks ingestion.
// The compaction allow-list governs what is actually forwarded across the socket.
const commonFields = {
  session_id: nonEmptyStringSchema,
  transcript_path: z.string().optional(),
  cwd: nonEmptyStringSchema,
  permission_mode: z.string().optional(),
  station_project_id: nonEmptyStringSchema.optional(),
  station_worktree_id: nonEmptyStringSchema.optional(),
  station_worktree_path: nonEmptyStringSchema.optional(),
  station_session_id: nonEmptyStringSchema.optional(),
  station_terminal_provider: nonEmptyStringSchema.optional(),
  station_terminal_target_id: nonEmptyStringSchema.optional(),
};

const SessionStartEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SessionStart"),
  source: nonEmptyStringSchema,
});

const UserPromptSubmitEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("UserPromptSubmit"),
  prompt: z.string(),
});

const PreToolUseEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PreToolUse"),
  tool_name: nonEmptyStringSchema,
  tool_input: z.unknown(),
  tool_use_id: nonEmptyStringSchema,
});

const PostToolUseEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: nonEmptyStringSchema,
  tool_use_id: nonEmptyStringSchema,
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  duration_ms: z.number().optional(),
});

const PermissionRequestEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PermissionRequest"),
  tool_name: nonEmptyStringSchema,
  tool_input: z.unknown(),
  permission_suggestions: z.unknown().optional(),
});

const NotificationEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("Notification"),
  notification_type: z.string().optional(),
  message: z.string().optional(),
});

const PreCompactEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("PreCompact"),
  trigger: z.string().optional(),
});

const StopEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().nullable().optional(),
});

const SessionEndEventSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SessionEnd"),
  reason: nonEmptyStringSchema,
});

export const ClaudeHookEventSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartEventSchema,
  UserPromptSubmitEventSchema,
  PreToolUseEventSchema,
  PostToolUseEventSchema,
  PermissionRequestEventSchema,
  NotificationEventSchema,
  PreCompactEventSchema,
  StopEventSchema,
  SessionEndEventSchema,
]);

function providerDataFromClaudeEvent(event: ClaudeHookEvent): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    claudeSessionId: event.session_id,
    hookEventName: event.hook_event_name,
    cwd: event.cwd,
  };
  if (event.transcript_path !== undefined) {
    providerData.transcriptPath = event.transcript_path;
  }
  if (event.permission_mode !== undefined) {
    providerData.permissionMode = event.permission_mode;
  }
  if ("source" in event) {
    providerData.source = event.source;
  }
  if ("reason" in event) {
    providerData.reason = event.reason;
  }
  if ("notification_type" in event && event.notification_type !== undefined) {
    providerData.notificationType = event.notification_type;
  }
  if ("tool_name" in event) {
    providerData.toolName = event.tool_name;
  }
  if ("tool_use_id" in event) {
    providerData.toolUseId = event.tool_use_id;
  }
  if ("duration_ms" in event && event.duration_ms !== undefined) {
    providerData.durationMs = event.duration_ms;
  }
  if ("stop_hook_active" in event) {
    providerData.stopHookActive = event.stop_hook_active;
  }
  if ("trigger" in event && event.trigger !== undefined) {
    providerData.trigger = event.trigger;
  }
  if (event.station_project_id !== undefined) {
    providerData.stationProjectId = event.station_project_id;
  }
  if (event.station_worktree_id !== undefined) {
    providerData.stationWorktreeId = event.station_worktree_id;
  }
  if (event.station_worktree_path !== undefined) {
    providerData.stationWorktreePath = event.station_worktree_path;
  }
  if (event.station_session_id !== undefined) {
    providerData.stationSessionId = event.station_session_id;
  }
  if (event.station_terminal_provider !== undefined) {
    providerData.stationTerminalProvider = event.station_terminal_provider;
  }
  if (event.station_terminal_target_id !== undefined) {
    providerData.stationTerminalTargetId = event.station_terminal_target_id;
  }
  return providerData;
}

function reportCorrelationFromClaudeEvent(
  event: ClaudeHookEvent,
): HarnessEventReport["correlation"] {
  const correlation: NonNullable<HarnessEventReport["correlation"]> = {
    cwd: event.cwd,
    nativeSessionId: event.session_id,
  };
  if (event.station_project_id !== undefined) {
    correlation.projectId = event.station_project_id;
  }
  if (event.station_worktree_id !== undefined) {
    correlation.worktreeId = event.station_worktree_id;
  }
  if (event.station_session_id !== undefined) {
    correlation.sessionId = event.station_session_id;
  }
  if (event.station_terminal_target_id !== undefined) {
    correlation.terminalTargetId = event.station_terminal_target_id;
    correlation.harnessRunId = `claude:${event.station_terminal_target_id}`;
  }
  return correlation;
}

function reportDiagnosticsFromClaudeEvent(
  event: ClaudeHookEvent,
  input: ClaudeHarnessEventReportInput["diagnostics"],
): HarnessEventReport["diagnostics"] {
  const diagnostics: NonNullable<HarnessEventReport["diagnostics"]> = {
    rawEventType: event.hook_event_name,
  };
  if (typeof input?.payloadBytes === "number") {
    diagnostics.payloadBytes = input.payloadBytes;
  }
  if (typeof input?.compactedBytes === "number") {
    diagnostics.compactedBytes = input.compactedBytes;
  }
  if (input?.compacted !== undefined) {
    diagnostics.compacted = input.compacted;
  }
  if (input?.truncated !== undefined) {
    diagnostics.truncated = input.truncated;
  }
  if (input?.omittedFieldNames !== undefined && input.omittedFieldNames.length > 0) {
    diagnostics.omittedFieldNames = input.omittedFieldNames;
  }
  return diagnostics;
}

function reportCoalesceKeyFromClaudeEvent(event: ClaudeHookEvent): string | undefined {
  if ("tool_use_id" in event) {
    return `tool:${event.tool_use_id}`;
  }
  if ("tool_name" in event) {
    return `tool:${event.tool_name}`;
  }
  return undefined;
}

function correlateClaudeEvent(
  event: ClaudeHookEvent,
  context: HarnessEventContext,
): {
  sessionId?: string;
  worktreeId?: string;
  harnessRunId?: string;
} {
  const terminal =
    terminalForId(event.station_terminal_target_id, context.terminalTargets) ??
    terminalForCwd(event.cwd, context.terminalTargets);
  const worktree =
    worktreeForId(event.station_worktree_id, context.worktrees) ??
    worktreeForPath(event.station_worktree_path, context.worktrees) ??
    worktreeForCwd(event.cwd, context.worktrees);
  const result: {
    sessionId?: string;
    worktreeId?: string;
    harnessRunId?: string;
  } = {};
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
  if (terminal?.harnessRunId !== undefined) {
    result.harnessRunId = terminal.harnessRunId;
  } else if (terminal !== undefined) {
    result.harnessRunId = `claude:${terminal.id}`;
  }
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
  cwd: string,
  targets: TerminalTargetObservation[],
): TerminalTargetObservation | undefined {
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
  path: string | undefined,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  if (path === undefined) {
    return undefined;
  }
  return worktrees.find((worktree) => sameObservedPath(worktree.path, path));
}

function worktreeForCwd(
  cwd: string,
  worktrees: WorktreeObservation[],
): WorktreeObservation | undefined {
  return (
    worktrees.find((worktree) => sameObservedPath(worktree.path, cwd)) ??
    worktrees.find((worktree) => observedPathIsSameOrInside(cwd, worktree.path))
  );
}

function turnFromClaudeHookEvent(event: ClaudeHookEvent): HarnessEventReport["turn"] | undefined {
  return event.hook_event_name === "Stop" && !event.stop_hook_active
    ? { kind: "turn_completed" }
    : undefined;
}

export function parseClaudeHookEvent(input: unknown): ClaudeHookEvent {
  const result = ClaudeHookEventSchema.safeParse(input);
  if (!result.success) {
    throw claudeHarnessError(
      "HARNESS_CLAUDE_EVENT_INVALID",
      "Claude Code hook event did not match a supported schema.",
      result.error,
    );
  }
  return result.data;
}

export function statusFromClaudeHookEvent(
  event: ClaudeHookEvent,
  observedAt: string,
): ObservedStatus | undefined {
  if (event.hook_event_name === "SessionStart") {
    return {
      value: "starting",
      confidence: "high",
      reason: `Claude Code session started from ${event.source}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PermissionRequest") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: `Claude Code requested permission for ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "Notification") {
    if (event.notification_type === "permission_prompt") {
      return {
        value: "needs_attention",
        confidence: "high",
        reason: "Claude Code is waiting for permission approval.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    }
    if (event.notification_type === "idle_prompt") {
      return {
        value: "idle",
        confidence: "medium",
        reason: "Claude Code is waiting for user input.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    }
    return undefined;
  }
  if (event.hook_event_name === "Stop") {
    if (event.stop_hook_active) {
      // stop_hook_active means a user Stop hook blocked stoppage — the agent keeps working.
      return {
        value: "working",
        confidence: "medium",
        reason: "A Stop hook kept Claude Code working.",
        source: "harness_event",
        updatedAt: observedAt,
      };
    }
    return {
      value: "idle",
      confidence: "high",
      reason: "Claude Code turn completed.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "SessionEnd") {
    if (event.reason === "clear") {
      // /clear is immediately followed by SessionStart(source: "clear"); mapping it to
      // exited would stick because exited+high is preserved against same-time reports.
      return undefined;
    }
    return {
      value: "exited",
      confidence: "high",
      reason: `Claude Code session ended (${event.reason}).`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreToolUse") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Claude Code is about to use ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PostToolUse") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Claude Code completed ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreCompact") {
    return {
      value: "working",
      confidence: "medium",
      reason: "Claude Code is about to compact the conversation.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return {
    value: "working",
    confidence: "medium",
    reason: "Claude Code received a user prompt.",
    source: "harness_event",
    updatedAt: observedAt,
  };
}

export function normalizeClaudeRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const eventName = hookEventNameOf(raw.event);
  if (eventName !== undefined && !isClaudeForwardedEventType(eventName)) {
    return [];
  }
  const event = parseClaudeHookEvent(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateClaudeEvent(event, context);
  const observation: HarnessEventObservation = {
    provider: "claude",
    rawEventType: event.hook_event_name,
    observedAt,
    providerData: providerDataFromClaudeEvent(event),
  };
  const status = statusFromClaudeHookEvent(event, observedAt);
  if (status !== undefined) {
    observation.status = status;
  }
  const turn = turnFromClaudeHookEvent(event);
  if (turn !== undefined) {
    observation.turn = turn;
  }
  if (correlation.sessionId !== undefined) {
    observation.sessionId = correlation.sessionId;
  }
  if (correlation.worktreeId !== undefined) {
    observation.worktreeId = correlation.worktreeId;
  }
  if (correlation.harnessRunId !== undefined) {
    observation.harnessRunId = correlation.harnessRunId;
  }
  observation.nativeSessionId = event.session_id;
  return [observation];
}

export function claudeHookPayloadToHarnessEventReport(
  input: ClaudeHarnessEventReportInput,
): HarnessEventReport {
  const event = parseClaudeHookEvent(input.payload);
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "claude",
    kind: "harness",
    eventType: event.hook_event_name,
    observedAt: input.observedAt,
  };
  const status = statusFromClaudeHookEvent(event, input.observedAt);
  if (status !== undefined) {
    report.status = status;
  }
  const turn = turnFromClaudeHookEvent(event);
  if (turn !== undefined) {
    report.turn = turn;
  }
  report.correlation = reportCorrelationFromClaudeEvent(event);
  report.diagnostics = reportDiagnosticsFromClaudeEvent(event, input.diagnostics);
  const coalesceKey = reportCoalesceKeyFromClaudeEvent(event);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  report.providerData = providerDataFromClaudeEvent(event);
  return HarnessEventReportSchema.parse(report);
}

// Claude Code has no turn identifier, so the observed timestamp is part of the report id;
// without it every turn's Stop would collide with the previous turn's and be deduped away.
export function claudeHookPayloadReportId(payload: unknown, observedAt: string): string {
  const event = parseClaudeHookEvent(payload);
  const parts = ["claude", event.session_id, event.hook_event_name];
  if ("tool_use_id" in event) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if ("tool_name" in event) {
    parts.push(`tool:${event.tool_name}`);
  }
  if ("notification_type" in event && event.notification_type !== undefined) {
    parts.push(`type:${event.notification_type}`);
  }
  if ("source" in event) {
    parts.push(`source:${event.source}`);
  }
  if ("reason" in event) {
    parts.push(`reason:${event.reason}`);
  }
  parts.push(observedAt);
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export function hookEventNameOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const name = (payload as Record<string, unknown>).hook_event_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
