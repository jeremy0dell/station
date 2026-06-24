// Codex hook events -> STATION HarnessEventObservation, normalized at the provider boundary.
// Upstream hook contract: https://developers.openai.com/codex/hooks
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
import { codexHarnessError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1);
const nullableStringSchema = z.string().nullable();
const permissionModeSchema = z
  .enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"])
  .optional();

const commonFields = {
  session_id: nonEmptyStringSchema,
  transcript_path: nullableStringSchema,
  cwd: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  permission_mode: permissionModeSchema,
  station_project_id: nonEmptyStringSchema.optional(),
  station_worktree_id: nonEmptyStringSchema.optional(),
  station_worktree_path: nonEmptyStringSchema.optional(),
  station_session_id: nonEmptyStringSchema.optional(),
  station_terminal_provider: nonEmptyStringSchema.optional(),
  station_terminal_target_id: nonEmptyStringSchema.optional(),
};

const optionalSubagentFields = {
  agent_id: nonEmptyStringSchema.optional(),
  agent_type: nonEmptyStringSchema.optional(),
};

const turnFields = {
  ...commonFields,
  turn_id: nonEmptyStringSchema,
  ...optionalSubagentFields,
};

const SessionStartEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .strict();

const UserPromptSubmitEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: nonEmptyStringSchema,
  })
  .strict();

const PreToolUseEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PreToolUse"),
    tool_name: nonEmptyStringSchema,
    tool_input: z.unknown(),
    tool_use_id: nonEmptyStringSchema,
  })
  .strict();

const PermissionRequestEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PermissionRequest"),
    tool_name: nonEmptyStringSchema,
    tool_input: z.unknown(),
  })
  .strict();

const PostToolUseEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PostToolUse"),
    tool_name: nonEmptyStringSchema,
    tool_use_id: nonEmptyStringSchema,
    tool_input: z.unknown(),
    tool_response: z.unknown(),
  })
  .strict();

const PreCompactEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PreCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const PostCompactEventSchema = z
  .object({
    ...turnFields,
    hook_event_name: z.literal("PostCompact"),
    trigger: z.enum(["manual", "auto"]),
  })
  .strict();

const SubagentStartEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SubagentStart"),
    turn_id: nonEmptyStringSchema,
    agent_id: nonEmptyStringSchema,
    agent_type: nonEmptyStringSchema,
  })
  .strict();

const SubagentStopEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("SubagentStop"),
    turn_id: nonEmptyStringSchema,
    agent_transcript_path: nullableStringSchema,
    agent_id: nonEmptyStringSchema,
    agent_type: nonEmptyStringSchema,
    stop_hook_active: z.boolean(),
    last_assistant_message: nullableStringSchema,
  })
  .strict();

const StopEventSchema = z
  .object({
    ...commonFields,
    hook_event_name: z.literal("Stop"),
    turn_id: nonEmptyStringSchema,
    stop_hook_active: z.boolean(),
    last_assistant_message: nullableStringSchema,
  })
  .strict();

export const CodexHookEventSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartEventSchema,
  UserPromptSubmitEventSchema,
  PreToolUseEventSchema,
  PermissionRequestEventSchema,
  PostToolUseEventSchema,
  PreCompactEventSchema,
  PostCompactEventSchema,
  SubagentStartEventSchema,
  SubagentStopEventSchema,
  StopEventSchema,
]);

export type CodexHookEvent = z.infer<typeof CodexHookEventSchema>;

export type CodexHarnessEventReportInput = {
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

export function parseCodexHookEvent(input: unknown): CodexHookEvent {
  const result = CodexHookEventSchema.safeParse(input);
  if (!result.success) {
    throw codexHarnessError(
      "HARNESS_CODEX_EVENT_INVALID",
      "Codex hook event did not match a supported strict schema.",
      result.error,
    );
  }
  return result.data;
}

export function normalizeCodexRawEvent(
  raw: RawHarnessEvent,
  context: HarnessEventContext,
): HarnessEventObservation[] {
  const event = parseCodexHookEvent(raw.event);
  const observedAt = raw.observedAt ?? new Date().toISOString();
  const correlation = correlateCodexEvent(event, context);
  const observation: HarnessEventObservation = {
    provider: "codex",
    rawEventType: event.hook_event_name,
    status: statusFromCodexHookEvent(event, observedAt),
    observedAt,
    providerData: providerDataFromCodexEvent(event),
  };
  const turn = turnFromCodexHookEvent(event);
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

export function codexHookPayloadToHarnessEventReport(
  input: CodexHarnessEventReportInput,
): HarnessEventReport {
  const event = parseCodexHookEvent(input.payload);
  const report: HarnessEventReport = {
    schemaVersion: STATION_SCHEMA_VERSION,
    reportId: input.reportId,
    provider: "codex",
    kind: "harness",
    eventType: event.hook_event_name,
    observedAt: input.observedAt,
    status: statusFromCodexHookEvent(event, input.observedAt),
  };
  const turn = turnFromCodexHookEvent(event);
  if (turn !== undefined) {
    report.turn = turn;
  }
  const correlation = reportCorrelationFromCodexEvent(event);
  if (correlation !== undefined) {
    report.correlation = correlation;
  }
  const diagnostics = reportDiagnosticsFromCodexEvent(event, input.diagnostics);
  if (diagnostics !== undefined) {
    report.diagnostics = diagnostics;
  }
  const coalesceKey = reportCoalesceKeyFromCodexEvent(event);
  if (coalesceKey !== undefined) {
    report.coalesceKey = coalesceKey;
  }
  report.providerData = providerDataFromCodexEvent(event);
  return HarnessEventReportSchema.parse(report);
}

export function codexHookPayloadReportId(payload: unknown): string {
  return codexHookEventReportId(parseCodexHookEvent(payload));
}

export function statusFromCodexHookEvent(
  event: CodexHookEvent,
  observedAt: string,
): ObservedStatus {
  if (event.hook_event_name === "SessionStart") {
    return {
      value: "starting",
      confidence: "high",
      reason: `Codex session started from ${event.source}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PermissionRequest") {
    return {
      value: "needs_attention",
      confidence: "high",
      reason: `Codex requested permission for ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "Stop") {
    return {
      value: "idle",
      confidence: "high",
      reason: "Codex turn completed.",
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "SubagentStop") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex subagent ${event.agent_type} stopped.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PostToolUse") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex completed ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreCompact") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex is about to compact the conversation (${event.trigger}).`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PostCompact") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex compacted the conversation (${event.trigger}).`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "SubagentStart") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex started subagent ${event.agent_type}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  if (event.hook_event_name === "PreToolUse") {
    return {
      value: "working",
      confidence: "medium",
      reason: `Codex is about to use ${event.tool_name}.`,
      source: "harness_event",
      updatedAt: observedAt,
    };
  }
  return {
    value: "working",
    confidence: "medium",
    reason: "Codex received a user prompt.",
    source: "harness_event",
    updatedAt: observedAt,
  };
}

function turnFromCodexHookEvent(event: CodexHookEvent): HarnessEventReport["turn"] | undefined {
  // stop_hook_active means a Stop hook is forcing continuation, so the turn is not
  // actually complete — matches Claude's turnFromClaudeHookEvent guard and avoids a
  // premature ready marker mid-turn.
  return event.hook_event_name === "Stop" && !event.stop_hook_active
    ? { kind: "turn_completed" }
    : undefined;
}

function providerDataFromCodexEvent(event: CodexHookEvent): Record<string, unknown> {
  const providerData: Record<string, unknown> = {
    codexSessionId: event.session_id,
    hookEventName: event.hook_event_name,
    cwd: event.cwd,
    model: event.model,
  };
  if (event.permission_mode !== undefined) {
    providerData.permissionMode = event.permission_mode;
  }
  if ("turn_id" in event) {
    providerData.codexTurnId = event.turn_id;
  }
  if ("source" in event) {
    providerData.source = event.source;
  }
  if ("tool_name" in event) {
    providerData.toolName = event.tool_name;
  }
  if ("tool_use_id" in event) {
    providerData.toolUseId = event.tool_use_id;
  }
  if ("agent_id" in event && event.agent_id !== undefined) {
    providerData.agentId = event.agent_id;
  }
  if ("agent_type" in event && event.agent_type !== undefined) {
    providerData.agentType = event.agent_type;
  }
  if ("agent_transcript_path" in event) {
    providerData.agentTranscriptPath = event.agent_transcript_path;
  }
  if ("trigger" in event) {
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

function reportCorrelationFromCodexEvent(
  event: CodexHookEvent,
): HarnessEventReport["correlation"] | undefined {
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
  }
  return correlation;
}

function reportDiagnosticsFromCodexEvent(
  event: CodexHookEvent,
  input: CodexHarnessEventReportInput["diagnostics"],
): HarnessEventReport["diagnostics"] | undefined {
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

function reportCoalesceKeyFromCodexEvent(event: CodexHookEvent): string | undefined {
  const parts: string[] = [];
  if ("turn_id" in event) {
    parts.push(`turn:${event.turn_id}`);
  }
  if ("tool_use_id" in event) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if ("tool_name" in event) {
    parts.push(`tool:${event.tool_name}`);
  }
  return parts.length === 0 ? undefined : parts.join(":");
}

function codexHookEventReportId(event: CodexHookEvent): string {
  const parts = ["codex", event.session_id, event.hook_event_name];
  if ("turn_id" in event) {
    parts.push(event.turn_id);
  }
  if ("tool_use_id" in event) {
    parts.push(`tool:${event.tool_use_id}`);
  } else if ("tool_name" in event) {
    parts.push(`tool:${event.tool_name}`);
  }
  if ("agent_id" in event && event.agent_id !== undefined) {
    parts.push(`agent:${event.agent_id}`);
  }
  if ("trigger" in event) {
    parts.push(`trigger:${event.trigger}`);
  }
  if ("source" in event) {
    parts.push(`source:${event.source}`);
  }
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function correlateCodexEvent(
  event: CodexHookEvent,
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
    result.harnessRunId = `codex:${terminal.id}`;
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
